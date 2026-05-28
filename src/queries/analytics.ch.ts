import { chQuery, chQueryRow } from '../lib/clickhouse.js'
import type { SessionFunnel } from '../types/analytics.js'
import type {
  LlmUsagePoint,
  ErrorRatePoint,
  LatencyStat,
  CostPoint,
  AgentSessionCount,
  TrendPoint,
} from '../types/analytics.js'
import { queryRow, queryRows } from '../lib/postgres.js'

export function windowToHours(window: string): number {
  const map: Record<string, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 }
  return map[window] ?? 24
}

export function windowToDays(window: string): number {
  const map: Record<string, number> = { '1h': 1, '24h': 1, '7d': 7, '30d': 30 }
  return map[window] ?? 1
}

export function windowToInterval(window: string): string {
  const map: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' }
  return map[window] ?? '24 hours'
}

export async function getLlmUsage(
  tenantId: string,
  window: string,
  agentId?: string
): Promise<LlmUsagePoint[]> {
  const hours = windowToHours(window)
  const rows = await chQuery<{
    llm_model: string
    hour: string
    call_count: number
    input_tok: number
    output_tok: number
    avg_latency_ms: number
    p95_latency_ms: number
  }>(
    `SELECT
      llm_model,
      toStartOfHour(hour)              AS hour,
      countMerge(call_count)           AS call_count,
      sumMerge(input_tokens_sum)       AS input_tok,
      sumMerge(output_tokens_sum)      AS output_tok,
      avgMerge(latency_avg)            AS avg_latency_ms,
      quantileMerge(0.95)(latency_p95) AS p95_latency_ms
    FROM obs_llm_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
      AND ({agentId: String} = '' OR agent_id = {agentId: String})
    GROUP BY llm_model, hour
    ORDER BY hour ASC`,
    { tenantId, hours, agentId: agentId ?? '' }
  )

  return rows.map((r) => ({
    hour: r.hour,
    llmModel: r.llm_model,
    llmCallCount: r.call_count,
    totalInputTok: r.input_tok,
    totalOutputTok: r.output_tok,
    avgLatencyMs: r.avg_latency_ms,
    p95LatencyMs: r.p95_latency_ms,
  }))
}

export async function getErrorRates(
  tenantId: string,
  window: string,
  agentId?: string
): Promise<ErrorRatePoint[]> {
  const hours = windowToHours(window)
  const rows = await chQuery<{
    agent_id: string
    node_name: string
    hour: string
    err_count: number
    tot_count: number
    error_rate: number
  }>(
    `SELECT
      agent_id,
      node_name,
      toStartOfHour(hour)                AS hour,
      sum(error_count)                   AS err_count,
      sum(total_count)                   AS tot_count,
      sum(error_count) / sum(total_count) AS error_rate
    FROM obs_error_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
      AND ({agentId: String} = '' OR agent_id = {agentId: String})
    GROUP BY agent_id, node_name, hour
    ORDER BY error_rate DESC`,
    { tenantId, hours, agentId: agentId ?? '' }
  )

  return rows.map((r) => ({
    hour: r.hour,
    agentId: r.agent_id,
    nodeName: r.node_name,
    errorCount: r.err_count,
    totalCount: r.tot_count,
    errorRate: r.error_rate,
  }))
}

export async function getLatency(
  tenantId: string,
  window: string,
  agentId?: string
): Promise<LatencyStat[]> {
  const hours = windowToHours(window)
  const rows = await chQuery<{
    hour: string
    llm_model: string
    avg_ms: number
    p95_ms: number
    call_count: number
  }>(
    `SELECT
      toStartOfHour(hour)              AS hour,
      llm_model,
      avgMerge(latency_avg)            AS avg_ms,
      quantileMerge(0.95)(latency_p95) AS p95_ms,
      countMerge(call_count)           AS call_count
    FROM obs_llm_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
      AND ({agentId: String} = '' OR agent_id = {agentId: String})
    GROUP BY hour, llm_model
    ORDER BY hour ASC`,
    { tenantId, hours, agentId: agentId ?? '' }
  )

  return rows.map((r) => ({
    hour: r.hour,
    llmModel: r.llm_model,
    avgMs: r.avg_ms,
    p95Ms: r.p95_ms,
    callCount: r.call_count,
  }))
}

const COST_PER_M_INPUT = 3.0
const COST_PER_M_OUTPUT = 15.0

export async function getCost(
  tenantId: string,
  window: string
): Promise<CostPoint[]> {
  const hours = windowToHours(window)
  const rows = await chQuery<{
    agent_id: string
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }>(
    `SELECT
      agent_id,
      toUInt64(sumMerge(input_tokens_sum))  AS input_tokens,
      toUInt64(sumMerge(output_tokens_sum)) AS output_tokens,
      toUInt64(sumMerge(input_tokens_sum) + sumMerge(output_tokens_sum)) AS total_tokens
    FROM obs_llm_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
    GROUP BY agent_id
    ORDER BY total_tokens DESC`,
    { tenantId, hours }
  )

  return rows.map((row) => ({
    agentId: row.agent_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd:
      (row.input_tokens / 1_000_000) * COST_PER_M_INPUT +
      (row.output_tokens / 1_000_000) * COST_PER_M_OUTPUT,
  }))
}

export async function getOverviewChMetrics(
  tenantId: string,
  hours: number
): Promise<{
  total_llm_calls: number
  total_input_tokens: number
  total_output_tokens: number
  avg_latency_ms: number
  p95_latency_ms: number
}> {
  const row = await chQueryRow<{
    total_llm_calls: number
    total_input_tokens: number
    total_output_tokens: number
    avg_latency_ms: number
    p95_latency_ms: number
  }>(
    `SELECT
      countMerge(call_count)           AS total_llm_calls,
      sumMerge(input_tokens_sum)       AS total_input_tokens,
      sumMerge(output_tokens_sum)      AS total_output_tokens,
      avgMerge(latency_avg)            AS avg_latency_ms,
      quantileMerge(0.95)(latency_p95) AS p95_latency_ms
    FROM obs_llm_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)`,
    { tenantId, hours }
  )
  return row ?? {
    total_llm_calls: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    avg_latency_ms: 0,
    p95_latency_ms: 0,
  }
}

export async function getSessionFunnelPg(
  tenantId: string,
  interval: string
): Promise<Omit<SessionFunnel, 'window' | 'completionRate'>> {
  const row = await queryRow<{
    total_started: number
    open: number
    finalised: number
    terminated: number
  }>(
    `SELECT
      COUNT(*)                                          AS total_started,
      COUNT(*) FILTER (WHERE status = 'open')           AS open,
      COUNT(*) FILTER (WHERE status = 'finalised')      AS finalised,
      COUNT(*) FILTER (WHERE status = 'terminated')     AS terminated
    FROM sessions
    WHERE tenant_id  = $1
      AND started_at >= NOW() - $2::interval`,
    [tenantId, interval]
  )

  return {
    totalStarted: Number(row?.total_started ?? 0),
    open:         Number(row?.open          ?? 0),
    finalised:    Number(row?.finalised     ?? 0),
    terminated:   Number(row?.terminated    ?? 0),
  }
}

export async function getAgentSessionCounts(
  tenantId: string,
  interval: string
): Promise<AgentSessionCount[]> {
  const rows = await queryRows<{ agent_id: string; agent_name: string | null; session_count: number }>(
    `SELECT s.agent_id, a.name AS agent_name, COUNT(*) AS session_count
     FROM sessions s
     LEFT JOIN agents a ON a.agent_id = s.agent_id
     WHERE s.tenant_id = $1 AND s.started_at >= NOW() - $2::interval
     GROUP BY s.agent_id, a.name
     ORDER BY session_count DESC`,
    [tenantId, interval],
  )
  return (rows ?? []).map(r => ({
    agentId:      r.agent_id,
    agentName:    r.agent_name,
    sessionCount: Number(r.session_count),
  }))
}

export async function getTrends(tenantId: string, hours: number): Promise<TrendPoint[]> {
  const rows = await chQuery<{
    hour: string
    session_count: number
    token_count: number
    avg_latency_ms: number
  }>(
    `SELECT
      toStartOfHour(hour)              AS hour,
      countMerge(call_count)           AS session_count,
      sumMerge(input_tokens_sum) + sumMerge(output_tokens_sum) AS token_count,
      avgMerge(latency_avg)            AS avg_latency_ms
    FROM obs_llm_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
    GROUP BY hour
    ORDER BY hour ASC`,
    { tenantId, hours },
  )
  return rows.map(r => ({
    hour:          r.hour,
    sessionCount:  Number(r.session_count),
    tokenCount:    Number(r.token_count),
    avgLatencyMs:  Number(r.avg_latency_ms),
  }))
}
