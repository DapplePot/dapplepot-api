import type {
  SecurityOverview, SessionRiskScore, SecurityFinding, RemediationCard
} from '../types/security.js'
import { queryRow, queryRows } from '../lib/postgres.js'

export async function getSecurityOverview(
  tenantId: string,
  windowHours: number = 168  // 7 days default
): Promise<SecurityOverview> {
  const [scored, dist, owasp, topRisk] = await Promise.all([
    // Total sessions scored in window
    queryRow<{ total: number; high_critical: number; avg_score: number }>(
      `SELECT count(*)                                                      AS total,
              COUNT(*) FILTER (WHERE risk_band IN ('high','critical'))      AS high_critical,
              avg(risk_score)                                               AS avg_score
       FROM session_risk_scores
       WHERE tenant_id = $1
         AND scored_at >= now() - make_interval(hours => $2)`,
      [tenantId, windowHours]
    ),

    // Band distribution
    queryRows<{ risk_band: string; count: number }>(
      `SELECT risk_band, count(*) AS count
       FROM session_risk_scores
       WHERE tenant_id = $1
         AND scored_at >= now() - make_interval(hours => $2)
       GROUP BY risk_band`,
      [tenantId, windowHours]
    ),

    // OWASP signal frequency (from security_findings)
    queryRows<{ owasp_id: string; count: number }>(
      `SELECT owasp_id, count(*) AS count
       FROM security_findings
       WHERE tenant_id = $1
         AND created_at >= now() - make_interval(hours => $2)
       GROUP BY owasp_id
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId, windowHours]
    ),

    // Top 5 highest-risk sessions
    queryRows<{ session_id: string; agent_id: string; risk_score: number; risk_band: string; signal_ids: string[] }>(
      `SELECT s.session_id, a.name AS agent_id, s.risk_score, s.risk_band, s.signal_ids
       FROM session_risk_scores s
       LEFT JOIN agents a ON a.agent_id = s.agent_id
       WHERE s.tenant_id = $1
         AND s.scored_at >= now() - make_interval(hours => $2)
       ORDER BY s.risk_score DESC
       LIMIT 5`,
      [tenantId, windowHours]
    ),
  ])

  const bandDist = Object.fromEntries(
    ['clean', 'low', 'medium', 'high', 'critical'].map(b => [b, 0])
  ) as Record<string, number>
  dist.forEach(r => { bandDist[r.risk_band] = r.count })

  return {
    window:          `${windowHours}h`,
    sessionsScored:  scored?.total ?? 0,
    highCriticalCount: scored?.high_critical ?? 0,
    avgRiskScore:    Math.round(scored?.avg_score ?? 0),
    topSignalId:     owasp[0]?.owasp_id ?? null,
    topSignalCount:  owasp[0]?.count ?? 0,
    bandDistribution: bandDist as Record<import('../types/security.js').RiskBand, number>,
    owaspFrequency:  owasp.map(r => ({ owaspId: r.owasp_id, count: r.count })),
    highRiskSessions: topRisk.map(r => ({
      sessionId: r.session_id,
      agentId:   r.agent_id,
      riskScore: r.risk_score,
      riskBand:  r.risk_band as import('../types/security.js').RiskBand,
      signalIds: r.signal_ids,
    })),
  }
}

export async function getSessionScore(
  tenantId: string,
  sessionId: string
): Promise<SessionRiskScore | null> {
  const row = await queryRow<any>(
    `SELECT * FROM session_risk_scores
     WHERE session_id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  )
  if (!row) return null
  return {
    sessionId:     row.session_id,
    tenantId:      row.tenant_id,
    agentId:       row.agent_id,
    riskScore:     row.risk_score,
    riskBand:      row.risk_band,
    signalCount:   row.signal_count,
    signalIds:     row.signal_ids,
    scorerVersion: row.scorer_version,
    scoredAt:      row.scored_at.toISOString(),
  }
}

export async function getSessionFindings(
  tenantId: string,
  sessionId: string
): Promise<SecurityFinding[]> {
  const rows = await queryRows<any>(
    `SELECT * FROM security_findings
     WHERE session_id = $1 AND tenant_id = $2
     ORDER BY created_at ASC`,
    [sessionId, tenantId]
  )
  return rows.map(r => ({
    findingId:      r.finding_id,
    sessionId:      r.session_id,
    eventId:        r.event_id,
    eventType:      r.event_type,
    signalId:       r.signal_id,
    sigType:        r.sig_type,
    owaspId:        r.owasp_id,
    severity:       r.severity,
    matchedText:    r.matched_text,
    detail:         r.detail,
    scoreContrib:   r.score_contrib,
    detectionPhase: r.detection_phase,
    createdAt:      r.created_at.toISOString(),
  }))
}

export async function getRemediationStats(
  tenantId: string,
  windowHours: number = 168
): Promise<RemediationCard[]> {
  const rows = await queryRows<{ signal_id: string; owasp_id: string; count: number }>(
    `SELECT signal_id, owasp_id, count(*) AS count
     FROM security_findings
     WHERE tenant_id = $1
       AND created_at >= now() - make_interval(hours => $2)
     GROUP BY signal_id, owasp_id
     ORDER BY count DESC
     LIMIT 10`,
    [tenantId, windowHours]
  )
  return rows.map(r => ({
    signalId:    r.signal_id,
    owaspId:     r.owasp_id,
    title:       REMEDIATION_GUIDE[r.signal_id]?.title ?? r.signal_id,
    description: REMEDIATION_GUIDE[r.signal_id]?.description ?? '',
    fixSteps:    REMEDIATION_GUIDE[r.signal_id]?.fixSteps ?? [],
    sdkSnippet:  REMEDIATION_GUIDE[r.signal_id]?.sdkSnippet ?? null,
    frequency:   r.count,
  }))
}

// Remediation copy — extend as new signals are added
const REMEDIATION_GUIDE: Record<string, {
  title: string; description: string; fixSteps: string[]; sdkSnippet: string | null
}> = {
  'INJ-001': {
    title: 'LLM01 — Add input validation before llm_start',
    description: 'Instruction override patterns detected in user messages. Add a pre-LLM sanitisation node that pattern-matches against the platform blocklist before forwarding user input to the model.',
    fixSteps: [
      'Add a sanitisation node before any LLM call node in your LangGraph graph.',
      'Enable server-side injection blocking in the SDK config.',
      'Review user input sources — consider stricter input validation at the API layer.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, block_injections=True)',
  },
  'OUT-001': {
    title: 'LLM02 — Sanitise LLM output before tool calls',
    description: 'LLM output is being passed directly to tool inputs. Add a sanitisation step in the node logic that validates and escapes LLM output before using it as tool arguments.',
    fixSteps: [
      'Never pass llm_end.output directly as tool_start.input.',
      'Define a strict schema for each tool\'s input parameters.',
      'Validate and cast LLM output fields against the tool schema before calling.',
    ],
    sdkSnippet: null,
  },
  'PII-001': {
    title: 'LLM06 — Enable SDK PII scrubber on outputs',
    description: 'Credit card numbers found in LLM or tool outputs. Enable the SDK PII scrubber for output payloads in addition to inputs.',
    fixSteps: [
      'Set scrub_output=True in DapplePot.instrument().',
      'Add a custom redaction pattern for your card format.',
      'Ensure tools that return payment data redact before returning.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, scrub_output=True)',
  },
}
