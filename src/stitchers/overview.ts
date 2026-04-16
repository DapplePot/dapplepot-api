import { queryRow } from '../lib/postgres.js'
import { getOverviewChMetrics, windowToHours, windowToInterval } from '../queries/analytics.ch.js'
import type { OverviewMetrics } from '../types/analytics.js'

export async function stitchOverview(
  tenantId: string,
  window: string
): Promise<OverviewMetrics> {
  const hours = windowToHours(window)
  const interval = windowToInterval(window)

  const [pgCounts, chMetrics] = await Promise.all([
    queryRow<{
      total_sessions: number
      live_sessions: number
      completed_sessions: number
      error_sessions: number
    }>(
      `SELECT
        COUNT(*)                                                  AS total_sessions,
        COUNT(*) FILTER (WHERE status = 'open')                   AS live_sessions,
        COUNT(*) FILTER (WHERE status = 'finalised')              AS completed_sessions,
        COUNT(*) FILTER (WHERE status = 'error')                  AS error_sessions
      FROM sessions
      WHERE tenant_id  = $1
        AND started_at >= now() - $2::interval`,
      [tenantId, interval]
    ),
    getOverviewChMetrics(tenantId, hours),
  ])

  return {
    window,
    totalSessions: Number(pgCounts?.total_sessions ?? 0),
    liveSessions: Number(pgCounts?.live_sessions ?? 0),
    completedSessions: Number(pgCounts?.completed_sessions ?? 0),
    errorSessions: Number(pgCounts?.error_sessions ?? 0),
    totalLlmCalls: Number(chMetrics.total_llm_calls),
    totalInputTokens: Number(chMetrics.total_input_tokens),
    totalOutputTokens: Number(chMetrics.total_output_tokens),
    avgLatencyMs: Number(chMetrics.avg_latency_ms),
    p95LatencyMs: Number(chMetrics.p95_latency_ms),
  }
}
