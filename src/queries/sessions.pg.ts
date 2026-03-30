import { queryRow, queryRows, queryValue } from '../lib/postgres.js'
import type { SessionSummary } from '../types/session.js'
import type { AlertSummary } from '../types/alert.js'
import type { SessionListParams } from '../types/common.js'

interface RawSession {
  session_id: string
  status: string
  agent_id: string | null
  agent_version: string | null
  environment: string
  deployment_id: string | null
  user_context_id: string | null
  started_at: Date | null
  ended_at: Date | null
  duration_ms: number | null
  last_active_at: Date | null
  alert_count: number
}

// Separate type for detail — does not extend RawSession because SELECT s.*
// does not include the computed alert_count column.
interface RawSessionDetail {
  session_id: string
  status: string
  agent_id: string | null
  agent_version: string | null
  environment: string
  deployment_id: string | null
  user_context_id: string | null
  started_at: Date | null
  ended_at: Date | null
  duration_ms: number | null
  last_active_at: Date | null
  exit_reason: string | null
  graph_state: Record<string, unknown> | null
  initial_input: Record<string, unknown> | null
  final_output: Record<string, unknown> | null
  last_alert_id: string | null
  last_alert_at: Date | null
  last_alert_severity: string | null
  last_alert_title: string | null
}

function mapSessionSummary(row: RawSession): SessionSummary {
  return {
    sessionId: row.session_id,
    status: row.status as SessionSummary['status'],
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    environment: row.environment,
    deploymentId: row.deployment_id,
    userContextId: row.user_context_id,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    lastActiveAt: row.last_active_at?.toISOString() ?? null,
    alertCount: row.alert_count,
  }
}

export async function getSessionList(
  tenantId: string,
  params: SessionListParams
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 100)
  const offset = (page - 1) * limit

  const rows = await queryRows<RawSession>(
    `SELECT
      s.session_id, s.status, s.agent_id, s.agent_version, s.environment,
      s.deployment_id, s.user_context_id, s.started_at, s.ended_at,
      s.duration_ms, s.last_active_at,
      COUNT(a.alert_id)::int AS alert_count
    FROM sessions s
    LEFT JOIN alerts a ON a.session_id = s.session_id
    WHERE s.tenant_id = $1
      AND ($2::text        IS NULL OR s.status          = $2)
      AND ($3::uuid        IS NULL OR s.agent_id         = $3)
      AND ($4::text        IS NULL OR s.environment      = $4)
      AND ($5::timestamptz IS NULL OR s.started_at       >= $5)
      AND ($6::timestamptz IS NULL OR s.started_at       < $6)
      AND ($7::text        IS NULL OR s.session_id::text LIKE $7 || '%'
                                    OR s.user_context_id = $7)
    GROUP BY s.session_id
    ORDER BY s.started_at DESC NULLS LAST
    LIMIT $8 OFFSET $9`,
    [
      tenantId,
      params.status ?? null,
      params.agentId ?? null,
      params.environment ?? null,
      params.since ?? null,
      params.until ?? null,
      params.q ?? null,
      limit,
      offset,
    ]
  )

  const total = await queryValue<number>(
    `SELECT COUNT(DISTINCT s.session_id)
    FROM sessions s
    WHERE s.tenant_id = $1
      AND ($2::text        IS NULL OR s.status          = $2)
      AND ($3::uuid        IS NULL OR s.agent_id         = $3)
      AND ($4::text        IS NULL OR s.environment      = $4)
      AND ($5::timestamptz IS NULL OR s.started_at       >= $5)
      AND ($6::timestamptz IS NULL OR s.started_at       < $6)
      AND ($7::text        IS NULL OR s.session_id::text LIKE $7 || '%'
                                    OR s.user_context_id = $7)`,
    [
      tenantId,
      params.status ?? null,
      params.agentId ?? null,
      params.environment ?? null,
      params.since ?? null,
      params.until ?? null,
      params.q ?? null,
    ]
  )

  return { sessions: rows.map(mapSessionSummary), total: Number(total ?? 0) }
}

export async function getSessionPg(tenantId: string, sessionId: string) {
  return queryRow<RawSessionDetail>(
    `SELECT
      s.*,
      a.alert_id        AS last_alert_id,
      a.triggered_at    AS last_alert_at,
      a.severity        AS last_alert_severity,
      a.title           AS last_alert_title
    FROM sessions s
    LEFT JOIN LATERAL (
      SELECT alert_id, triggered_at, severity, payload->>'title' AS title
      FROM   alerts
      WHERE  session_id = s.session_id
      ORDER  BY triggered_at DESC
      LIMIT  1
    ) a ON true
    WHERE s.session_id = $1
      AND s.tenant_id  = $2`,
    [sessionId, tenantId]
  )
}

export async function getSessionAlerts(
  tenantId: string,
  sessionId: string
): Promise<AlertSummary[]> {
  const rows = await queryRows<{
    alert_id: string
    rule_id: string | null
    rule_name: string
    severity: string
    triggered_at: Date
    status: string
    resolved_at: Date | null
    title: string
    message: string
    rule_type: string
    agent_id: string | null
  }>(
    `SELECT
      a.alert_id, a.rule_id, a.rule_name, a.severity, a.triggered_at,
      a.status, a.resolved_at,
      a.payload->>'title'      AS title,
      a.payload->>'message'    AS message,
      a.payload->>'rule_type'  AS rule_type,
      s.agent_id
    FROM alerts a
    LEFT JOIN sessions s ON s.session_id = a.session_id
    WHERE a.session_id = $1
      AND a.tenant_id  = $2
    ORDER BY a.triggered_at DESC`,
    [sessionId, tenantId]
  )

  return rows.map((r) => ({
    alertId: r.alert_id,
    ruleId: r.rule_id,
    ruleName: r.rule_name ?? '',
    ruleType: r.rule_type ?? '',
    sessionId,
    agentId: r.agent_id,
    severity: r.severity as AlertSummary['severity'],
    title: r.title ?? '',
    message: r.message ?? '',
    status: r.status as AlertSummary['status'],
    triggeredAt: r.triggered_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  }))
}

export async function getLiveSessions(tenantId: string): Promise<SessionSummary[]> {
  const rows = await queryRows<RawSession>(
    `SELECT
      s.session_id, s.status, s.agent_id, s.agent_version, s.environment,
      s.deployment_id, s.user_context_id, s.started_at, s.ended_at,
      s.duration_ms, s.last_active_at,
      0::int AS alert_count
    FROM sessions s
    WHERE s.tenant_id      = $1
      AND s.status         = 'open'
      AND s.last_active_at >= now() - interval '30 seconds'
    ORDER BY s.last_active_at DESC
    LIMIT 50`,
    [tenantId]
  )
  return rows.map(mapSessionSummary)
}
