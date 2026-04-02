import { chQuery, chQueryRow } from '../lib/clickhouse.js'
import type { SessionFunnel } from '../types/analytics.js'
import type {
  LlmUsagePoint,
  ErrorRatePoint,
  LatencyStat,
  CostPoint,
} from '../types/analytics.js'
import { queryRow } from '../lib/postgres.js'

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
  const days = windowToDays(window)
  const row = await chQueryRow<{
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }>(
    `SELECT
      sum(input_tokens)  AS input_tokens,
      sum(output_tokens) AS output_tokens,
      sum(total_tokens)  AS total_tokens
    FROM obs_session_tokens
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND toDate(created_at) >= today() - {days: UInt32}`,
    { tenantId, days }
  )

  if (!row) return []
  return [{
    agentId: '',
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd:
      (row.input_tokens / 1_000_000) * COST_PER_M_INPUT +
      (row.output_tokens / 1_000_000) * COST_PER_M_OUTPUT,
  }]
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
    reached_open: number
    reached_terminal: number
    completed: number
    killed: number
    interrupted: number
    errored: number
  }>(
    `SELECT
      COUNT(*)                                                                    AS total_started,
      COUNT(*) FILTER (WHERE status != 'stub')                                   AS reached_open,
      COUNT(*) FILTER (WHERE status IN ('finalised','killed','interrupted','error')) AS reached_terminal,
      COUNT(*) FILTER (WHERE status = 'finalised')                               AS completed,
      COUNT(*) FILTER (WHERE status = 'killed')                                  AS killed,
      COUNT(*) FILTER (WHERE status = 'interrupted')                             AS interrupted,
      COUNT(*) FILTER (WHERE status = 'error')                                   AS errored
    FROM sessions
    WHERE tenant_id  = $1
      AND started_at >= NOW() - $2::interval`,
    [tenantId, interval]
  )

  return {
    totalStarted: Number(row?.total_started ?? 0),
    reachedOpen: Number(row?.reached_open ?? 0),
    reachedTerminal: Number(row?.reached_terminal ?? 0),
    completed: Number(row?.completed ?? 0),
    killed: Number(row?.killed ?? 0),
    interrupted: Number(row?.interrupted ?? 0),
    errored: Number(row?.errored ?? 0),
  }
}
