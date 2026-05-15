import { createHash } from 'crypto'
import { chQuery } from './clickhouse.js'
import { queryRows } from './postgres.js'
import { uploadAuditArchive, auditArchiveKey } from './s3.js'
import { env } from '../env.js'
import {
  createAuditArchive,
  sealAuditArchive,
  failAuditArchive,
  getLastSealedArchive,
} from '../queries/audit.pg.js'

// ClickHouse DateTime64 expects "YYYY-MM-DD HH:MM:SS.mmm" — no T, no Z
function toChTs(iso: string): string {
  return iso.replace('T', ' ').replace(/Z$/, '').replace(/\+\d{2}:\d{2}$/, '')
}

interface AuditEvent {
  eventId:         string
  sessionId:       string
  eventType:       string
  eventCategory:   string
  emittedAt:       string
  sequenceIndex:   number
  nodeName:        string
  llmModel:        string
  llmInputTokens:  number
  llmOutputTokens: number
  toolName:        string
  errorCode:       string
}

interface AuditFinding {
  findingId:     string
  sessionId:     string
  eventId:       string
  framework:     string
  owaspSignalId: string
  subCheckId:    string
  checkLabel:    string
  severity:      string
  category:      string
  detectionPhase: string
  actionTaken:   string
  matchedText:   string | null
  triggeredAt:   string
}

interface AuditAlert {
  alertId:     string
  sessionId:   string | null
  ruleName:    string
  severity:    string
  triggeredAt: string
  title:       string | null
}

interface AuditSession {
  sessionId:   string
  agentId:     string | null
  environment: string | null
  status:      string
  startedAt:   string | null
  endedAt:     string | null
  durationMs:  number | null
}

export interface AuditReport {
  schemaVersion: '1'
  reportType:    'monthly' | 'live' | 'session'
  generatedAt:   string
  tenantId:      string
  agentId:       string | null
  period: {
    start: string
    end:   string
  }
  governance: {
    sealed:   boolean
    sealedAt: string | null
    sha256:   string | null
  }
  summary: {
    sessionCount: number
    eventCount:   number
    findingCount: number
    alertCount:   number
  }
  sessions:  AuditSession[]
  events:    AuditEvent[]
  findings:  AuditFinding[]
  alerts:    AuditAlert[]
}

async function fetchEvents(
  tenantId: string,
  periodStart: string,
  periodEnd:   string,
  agentId:     string | null,
  sessionId:   string | null
): Promise<AuditEvent[]> {
  const agentClause   = agentId   ? `AND agent_id   = {agentId: String}` : ''
  const sessionClause = sessionId ? `AND session_id = {sessionId: UUID}`  : ''
  // For session-scoped queries use <= so graph_end emitted at exactly session.endedAt is included
  const endOp = sessionId ? '<=' : '<'

  const rows = await chQuery<{
    event_id:          string
    session_id:        string
    event_type:        string
    event_category:    string
    emitted_at:        string
    sequence_index:    number
    node_name:         string
    llm_model:         string
    llm_input_tokens:  number
    llm_output_tokens: number
    tool_name:         string
    error_code:        string
  }>(
    `SELECT
       event_id, session_id, event_type, event_category, emitted_at,
       sequence_index, node_name, llm_model,
       llm_input_tokens, llm_output_tokens,
       tool_name, error_code
     FROM obs_events
     WHERE tenant_id  = {tenantId: String}
       AND emitted_at >= {start: DateTime64(3)}
       AND emitted_at ${endOp} {end: DateTime64(3)}
       ${agentClause}
       ${sessionClause}
     ORDER BY emitted_at ASC, sequence_index ASC`,
    {
      tenantId,
      start: toChTs(periodStart),
      end:   toChTs(periodEnd),
      ...(agentId   ? { agentId }   : {}),
      ...(sessionId ? { sessionId } : {}),
    }
  )

  return rows.map(r => ({
    eventId:         r.event_id,
    sessionId:       r.session_id,
    eventType:       r.event_type,
    eventCategory:   r.event_category,
    emittedAt:       r.emitted_at,
    sequenceIndex:   r.sequence_index,
    nodeName:        r.node_name,
    llmModel:        r.llm_model,
    llmInputTokens:  r.llm_input_tokens,
    llmOutputTokens: r.llm_output_tokens,
    toolName:        r.tool_name,
    errorCode:       r.error_code,
  }))
}

async function fetchFindings(
  tenantId: string,
  periodStart: string,
  periodEnd:   string,
  agentId:     string | null,
  sessionId:   string | null
): Promise<AuditFinding[]> {
  // Session-scoped: filter by session_id only — skips time range to avoid boundary issues.
  // Monthly archive: filter by time range only — no session filter needed.
  const [whereExtra, params] = sessionId
    ? [`AND sf.session_id = $2::uuid`,                        [tenantId, sessionId]]
    : [`AND COALESCE(sf.emitted_at, sf.created_at) >= $2
        AND COALESCE(sf.emitted_at, sf.created_at) <  $3`,    [tenantId, periodStart, periodEnd]]

  const rows = await queryRows<{
    finding_id:      string
    session_id:      string
    event_id:        string
    framework:       string
    owasp_signal_id: string
    sub_check_id:    string
    check_label:     string
    severity:        string
    category:        string
    detection_phase: string
    action_taken:    string
    triggered_at:    Date
  }>(
    `SELECT
       sf.finding_id, sf.session_id, sf.event_id, sf.framework,
       sf.owasp_signal_id, sf.sub_check_id, sf.check_label,
       sf.severity, sf.category, sf.detection_phase,
       COALESCE(sa.action_taken, 'alert') AS action_taken,
       COALESCE(sf.emitted_at, sf.created_at) AS triggered_at
     FROM security_findings sf
     LEFT JOIN session_actions sa
            ON sa.session_id  = sf.session_id
           AND sa.sub_check_id = sf.sub_check_id
     WHERE sf.tenant_id = $1::uuid
       ${whereExtra}
     ORDER BY triggered_at ASC`,
    params
  )

  return rows.map(r => ({
    findingId:      r.finding_id,
    sessionId:      r.session_id,
    eventId:        r.event_id,
    framework:      r.framework,
    owaspSignalId:  r.owasp_signal_id,
    subCheckId:     r.sub_check_id,
    checkLabel:     r.check_label,
    severity:       r.severity,
    category:       r.category,
    detectionPhase: r.detection_phase,
    actionTaken:    r.action_taken,
    matchedText:    '[REDACTED]',
    triggeredAt:    new Date(r.triggered_at).toISOString(),
  }))
}

async function fetchSessions(
  tenantId: string,
  periodStart: string,
  periodEnd:   string,
  agentId:     string | null,
  sessionId:   string | null
): Promise<AuditSession[]> {
  const rows = await queryRows<{
    session_id:  string
    agent_id:    string | null
    environment: string | null
    status:      string
    started_at:  Date | null
    ended_at:    Date | null
    duration_ms: number | null
  }>(
    `SELECT session_id, agent_id, environment, status, started_at, ended_at, duration_ms
     FROM sessions
     WHERE tenant_id = $1::uuid
       AND (started_at >= $2 OR started_at IS NULL)
       AND (started_at <  $3 OR started_at IS NULL)
       AND ($4::uuid IS NULL OR agent_id  = $4::uuid)
       AND ($5::uuid IS NULL OR session_id = $5::uuid)
     ORDER BY started_at ASC NULLS LAST`,
    [tenantId, periodStart, periodEnd, agentId ?? null, sessionId ?? null]
  )

  return rows.map(r => ({
    sessionId:   r.session_id,
    agentId:     r.agent_id,
    environment: r.environment,
    status:      r.status,
    startedAt:   r.started_at?.toISOString() ?? null,
    endedAt:     r.ended_at?.toISOString() ?? null,
    durationMs:  r.duration_ms,
  }))
}

async function fetchAlerts(
  tenantId: string,
  periodStart: string,
  periodEnd:   string,
  sessionId:   string | null
): Promise<AuditAlert[]> {
  const [alertWhereExtra, alertParams] = sessionId
    ? [`AND session_id = $2::uuid`,             [tenantId, sessionId]]
    : [`AND triggered_at >= $2
        AND triggered_at <  $3`,                [tenantId, periodStart, periodEnd]]

  const rows = await queryRows<{
    alert_id:     string
    session_id:   string | null
    rule_name:    string | null
    severity:     string
    triggered_at: Date
    payload:      { title?: string } | null
  }>(
    `SELECT alert_id, session_id, rule_name, severity, triggered_at, payload
     FROM alerts
     WHERE tenant_id = $1::uuid
       ${alertWhereExtra}
     ORDER BY triggered_at ASC`,
    alertParams
  )

  return rows.map(r => ({
    alertId:     r.alert_id,
    sessionId:   r.session_id,
    ruleName:    r.rule_name ?? '',
    severity:    r.severity,
    triggeredAt: r.triggered_at.toISOString(),
    title:       r.payload?.title ?? null,
  }))
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function buildReport(params: {
  reportType:  AuditReport['reportType']
  tenantId:    string
  agentId:     string | null
  periodStart: string
  periodEnd:   string
  sessions:    AuditSession[]
  events:      AuditEvent[]
  findings:    AuditFinding[]
  alerts:      AuditAlert[]
  sealed:      boolean
  sealedAt:    string | null
}): AuditReport {
  const body = {
    schemaVersion: '1' as const,
    reportType:    params.reportType,
    generatedAt:   new Date().toISOString(),
    tenantId:      params.tenantId,
    agentId:       params.agentId,
    period: {
      start: params.periodStart,
      end:   params.periodEnd,
    },
    summary: {
      sessionCount: params.sessions.length,
      eventCount:   params.events.length,
      findingCount: params.findings.length,
      alertCount:   params.alerts.length,
    },
    sessions:  params.sessions,
    events:    params.events,
    findings:  params.findings,
    alerts:    params.alerts,
  }

  const hash = params.sealed ? sha256(JSON.stringify(body)) : null

  return {
    governance: {
      sealed:   params.sealed,
      sealedAt: params.sealedAt,
      sha256:   hash,
    },
    ...body,
  }
}

export async function sealMonthlyArchive(params: {
  tenantId:    string
  agentId:     string | null
  periodStart: string
  periodEnd:   string
}): Promise<{ archiveId: string; report: AuditReport }> {
  const archiveId = await createAuditArchive(params)

  try {
    const [sessions, events, findings, alerts] = await Promise.all([
      fetchSessions(params.tenantId, params.periodStart, params.periodEnd, params.agentId, null),
      fetchEvents(params.tenantId, params.periodStart, params.periodEnd, params.agentId, null),
      fetchFindings(params.tenantId, params.periodStart, params.periodEnd, params.agentId, null),
      fetchAlerts(params.tenantId, params.periodStart, params.periodEnd, null),
    ])

    const sealedAt = new Date().toISOString()
    const report = buildReport({
      reportType:  'monthly',
      tenantId:    params.tenantId,
      agentId:     params.agentId,
      periodStart: params.periodStart,
      periodEnd:   params.periodEnd,
      sessions,
      events,
      findings,
      alerts,
      sealed:   true,
      sealedAt,
    })

    const period = params.periodStart.slice(0, 7)           // "YYYY-MM"
    const s3Key  = auditArchiveKey(params.tenantId, period, archiveId)
    await uploadAuditArchive(s3Key, JSON.stringify(report, null, 2))

    await sealAuditArchive({
      archiveId,
      tenantId:     params.tenantId,
      sha256:       report.governance.sha256!,
      s3Bucket:     env.AUDIT_S3_BUCKET,
      s3Key,
      sessionCount: sessions.length,
      eventCount:   events.length,
      findingCount: findings.length,
      alertCount:   alerts.length,
    })

    return { archiveId, report }
  } catch (err) {
    await failAuditArchive(archiveId, params.tenantId, String(err))
    throw err
  }
}

export async function generateLiveReport(params: {
  tenantId: string
  agentId:  string | null
}): Promise<AuditReport> {
  const lastArchive = await getLastSealedArchive(params.tenantId, params.agentId)
  const periodStart = lastArchive?.periodEnd ?? new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
  ).toISOString()
  const periodEnd = new Date().toISOString()

  const [sessions, events, findings, alerts] = await Promise.all([
    fetchSessions(params.tenantId, periodStart, periodEnd, params.agentId, null),
    fetchEvents(params.tenantId, periodStart, periodEnd, params.agentId, null),
    fetchFindings(params.tenantId, periodStart, periodEnd, params.agentId, null),
    fetchAlerts(params.tenantId, periodStart, periodEnd, null),
  ])

  return buildReport({
    reportType:  'live',
    tenantId:    params.tenantId,
    agentId:     params.agentId,
    periodStart,
    periodEnd,
    sessions,
    events,
    findings,
    alerts,
    sealed:   false,
    sealedAt: null,
  })
}

export async function generateSessionReport(params: {
  tenantId:  string
  sessionId: string
}): Promise<AuditReport> {
  const sessionRows = await fetchSessions(
    params.tenantId,
    '1970-01-01T00:00:00Z',
    '9999-01-01T00:00:00Z',
    null,
    params.sessionId
  )
  const session = sessionRows[0]
  const periodStart = session?.startedAt ?? '1970-01-01T00:00:00Z'
  const periodEnd   = session?.endedAt   ?? new Date().toISOString()

  const [events, findings, alerts] = await Promise.all([
    fetchEvents(params.tenantId, periodStart, periodEnd, null, params.sessionId),
    fetchFindings(params.tenantId, periodStart, periodEnd, null, params.sessionId),
    fetchAlerts(params.tenantId, periodStart, periodEnd, params.sessionId),
  ])

  return buildReport({
    reportType:  'session',
    tenantId:    params.tenantId,
    agentId:     session?.agentId ?? null,
    periodStart,
    periodEnd,
    sessions:  sessionRows,
    events,
    findings,
    alerts,
    sealed:   false,
    sealedAt: null,
  })
}
