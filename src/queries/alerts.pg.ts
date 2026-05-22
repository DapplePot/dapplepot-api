import { queryRow, queryRows, queryValue } from '../lib/postgres.js'
import type { AlertSummary, AlertDetail, AlertDelivery, AlertDetailPayload, AlertStats } from '../types/alert.js'
import type { AlertListParams } from '../types/common.js'

function mapAlertSummary(r: Record<string, unknown>): AlertSummary {
  return {
    alertId: r['alert_id'] as string,
    ruleId: (r['rule_id'] as string | null) ?? null,
    ruleName: (r['rule_name'] as string) ?? '',
    ruleType: (r['rule_type'] as string) ?? '',
    source: ((r['source'] as string | null) ?? 'policy') as 'security' | 'policy',
    sessionId: (r['session_id'] as string | null) ?? null,
    agentId: (r['agent_id'] as string | null) ?? null,
    agentName: (r['agent_name'] as string | null) ?? null,
    severity: r['severity'] as AlertSummary['severity'],
    title: (r['title'] as string) ?? '',
    message: (r['message'] as string) ?? '',
    status: r['status'] as AlertSummary['status'],
    triggeredAt: r['triggered_at'] instanceof Date
      ? (r['triggered_at'] as Date).toISOString()
      : String(r['triggered_at']),
    resolvedAt: r['resolved_at']
      ? (r['resolved_at'] instanceof Date ? (r['resolved_at'] as Date).toISOString() : String(r['resolved_at']))
      : null,
  }
}

export async function getAlertList(
  tenantId: string,
  params: AlertListParams
): Promise<{ alerts: AlertSummary[]; total: number }> {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 100)
  const offset = (page - 1) * limit

  const rows = await queryRows<Record<string, unknown>>(
    `SELECT
      a.alert_id, a.rule_id, a.rule_name, a.severity, a.session_id,
      a.triggered_at, a.status, a.resolved_at,
      a.payload->>'title'     AS title,
      a.payload->>'message'   AS message,
      a.payload->>'rule_type' AS rule_type,
      COALESCE(a.payload->>'source', 'policy') AS source,
      s.agent_id,
      ag.name                 AS agent_name
    FROM alerts a
    LEFT JOIN sessions s ON s.session_id = a.session_id
    LEFT JOIN agents ag ON ag.agent_id = s.agent_id
    WHERE a.tenant_id    = $1
      AND ($2::text        IS NULL OR a.severity = $2)
      AND ($3::text        IS NULL OR a.status   = $3)
      AND ($4::uuid        IS NULL OR a.rule_id  = $4)
      AND ($5::uuid        IS NULL OR s.agent_id = $5)
      AND ($6::timestamptz IS NULL OR a.triggered_at >= $6)
      AND ($7::timestamptz IS NULL OR a.triggered_at <  $7)
      AND ($8::text        IS NULL OR COALESCE(a.payload->>'source', 'policy') = $8)
    ORDER BY a.triggered_at DESC
    LIMIT $9 OFFSET $10`,
    [
      tenantId,
      params.severity ?? null,
      params.status ?? null,
      params.ruleId ?? null,
      params.agentId ?? null,
      params.since ?? null,
      params.until ?? null,
      params.source ?? null,
      limit,
      offset,
    ]
  )

  const total = await queryValue<number>(
    `SELECT COUNT(*)
    FROM alerts a
    LEFT JOIN sessions s ON s.session_id = a.session_id
    WHERE a.tenant_id    = $1
      AND ($2::text        IS NULL OR a.severity = $2)
      AND ($3::text        IS NULL OR a.status   = $3)
      AND ($4::uuid        IS NULL OR a.rule_id  = $4)
      AND ($5::uuid        IS NULL OR s.agent_id = $5)
      AND ($6::timestamptz IS NULL OR a.triggered_at >= $6)
      AND ($7::timestamptz IS NULL OR a.triggered_at <  $7)
      AND ($8::text        IS NULL OR COALESCE(a.payload->>'source', 'policy') = $8)`,
    [
      tenantId,
      params.severity ?? null,
      params.status ?? null,
      params.ruleId ?? null,
      params.agentId ?? null,
      params.since ?? null,
      params.until ?? null,
      params.source ?? null,
    ]
  )

  return { alerts: rows.map(mapAlertSummary), total: Number(total ?? 0) }
}

export async function getAlertDetail(
  tenantId: string,
  alertId: string
): Promise<AlertDetail | undefined> {
  const row = await queryRow<Record<string, unknown>>(
    `SELECT
      a.alert_id, a.rule_id, a.rule_name, a.severity, a.session_id,
      a.triggered_at, a.status, a.resolved_at, a.dedup_key, a.payload,
      a.payload->>'title'     AS title,
      a.payload->>'message'   AS message,
      a.payload->>'rule_type' AS rule_type,
      COALESCE(a.payload->>'source', 'policy') AS source,
      s.agent_id,
      ag.name                 AS agent_name
    FROM alerts a
    LEFT JOIN sessions s ON s.session_id = a.session_id
    LEFT JOIN agents ag ON ag.agent_id = s.agent_id
    WHERE a.alert_id  = $1
      AND a.tenant_id = $2`,
    [alertId, tenantId]
  )
  if (!row) return undefined

  const deliveries = await queryRows<Record<string, unknown>>(
    `SELECT
      ad.delivery_id, ad.channel AS channel_id, ad.channel AS channel_name,
      ad.status, ad.attempt_count, ad.last_attempted_at,
      ad.delivered_at, ad.error_message
    FROM alert_deliveries ad
    WHERE ad.alert_id = $1
    ORDER BY ad.last_attempted_at DESC`,
    [alertId]
  )

  return {
    ...mapAlertSummary(row),
    dedupKey: (row['dedup_key'] as string) ?? '',
    payload: (row['payload'] as AlertDetailPayload) ?? {},
    deliveries: deliveries.map((d): AlertDelivery => ({
      deliveryId: d['delivery_id'] as string,
      channelId: d['channel_id'] as string,
      channelName: (d['channel_name'] as string) ?? '',
      status: d['status'] as AlertDelivery['status'],
      attemptCount: d['attempt_count'] as number,
      lastAttemptedAt: d['last_attempted_at']
        ? (d['last_attempted_at'] instanceof Date
          ? (d['last_attempted_at'] as Date).toISOString()
          : String(d['last_attempted_at']))
        : null,
      deliveredAt: d['delivered_at']
        ? (d['delivered_at'] instanceof Date
          ? (d['delivered_at'] as Date).toISOString()
          : String(d['delivered_at']))
        : null,
      errorMessage: (d['error_message'] as string | null) ?? null,
    })),
  }
}

export async function updateAlertStatus(
  tenantId: string,
  alertId: string,
  status: 'open' | 'acknowledged' | 'resolved'
): Promise<{ alertId: string; status: string; resolvedAt: string | null } | undefined> {
  const row = await queryRow<{ alert_id: string; status: string; resolved_at: Date | null }>(
    `UPDATE alerts
    SET
      status      = $3,
      resolved_at = CASE
                      WHEN $3 = 'resolved' THEN NOW()
                      WHEN $3 = 'open'     THEN NULL
                      ELSE resolved_at
                    END
    WHERE alert_id  = $1
      AND tenant_id = $2
    RETURNING alert_id, status, resolved_at`,
    [alertId, tenantId, status]
  )
  if (!row) return undefined
  return {
    alertId: row.alert_id,
    status: row.status,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  }
}

export async function getAlertStats(
  tenantId: string,
  interval: string
): Promise<AlertStats> {
  const [severityRows, topRulesRows] = await Promise.all([
    queryRows<{
      severity: string
      total: number
      open: number
      acknowledged: number
      resolved: number
    }>(
      `SELECT
        severity,
        COUNT(*)                             AS total,
        COUNT(*) FILTER (WHERE status = 'open')         AS open,
        COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
        COUNT(*) FILTER (WHERE status = 'resolved')     AS resolved
      FROM alerts
      WHERE tenant_id    = $1
        AND triggered_at >= NOW() - $2::interval
      GROUP BY severity`,
      [tenantId, interval]
    ),
    queryRows<{ rule_id: string; rule_name: string; count: number }>(
      `SELECT rule_id, rule_name, COUNT(*) AS count
      FROM alerts
      WHERE tenant_id    = $1
        AND triggered_at >= NOW() - $2::interval
      GROUP BY rule_id, rule_name
      ORDER BY count DESC
      LIMIT 10`,
      [tenantId, interval]
    ),
  ])

  return {
    window: interval,
    bySeverity: severityRows.map((r) => ({
      severity: r.severity as AlertStats['bySeverity'][number]['severity'],
      total: Number(r.total),
      open: Number(r.open),
      acknowledged: Number(r.acknowledged),
      resolved: Number(r.resolved),
    })),
    topRules: topRulesRows.map((r) => ({
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      count: Number(r.count),
    })),
  }
}
