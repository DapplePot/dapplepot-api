import { chQueryRow } from '../lib/clickhouse.js'

export interface ToolCallBaseline {
  sessionCount: number
  mean:         number | null  // null when no data
  stddev:       number | null
  p90:          number | null  // 90th-percentile — practical "normal max"
}

/**
 * Computes 7-day tool-call-per-session statistics for an agent from ClickHouse.
 * Used by the UI to display the statistical baseline alongside the manual cap.
 *
 * Mirrors the Z-score query in signal_ow_llm06_tool_count (llm_signals.py):
 *   SELECT session_id, count() AS tool_call_count
 *   FROM obs_events
 *   WHERE agent_id = ? AND event_type = 'tool_start' AND emitted_at >= now() - 7 DAY
 *   GROUP BY session_id
 */
export async function getToolCallBaseline(
  tenantId: string,
  agentId:  string,
): Promise<ToolCallBaseline> {
  const row = await chQueryRow<{
    session_count: number
    mean:          number
    stddev:        number
    p90:           number
  }>(
    `SELECT
       count()                       AS session_count,
       avg(tool_call_count)          AS mean,
       stddevPop(tool_call_count)    AS stddev,
       quantile(0.90)(tool_call_count) AS p90
     FROM (
       SELECT session_id, count() AS tool_call_count
       FROM obs_events
       WHERE tenant_id  = {tenantId: String}
         AND agent_id   = {agentId:  String}
         AND event_type = 'tool_start'
         AND emitted_at >= now() - INTERVAL 7 DAY
       GROUP BY session_id
     )`,
    { tenantId, agentId },
  )

  if (!row || row.session_count === 0) {
    return { sessionCount: 0, mean: null, stddev: null, p90: null }
  }

  return {
    sessionCount: row.session_count,
    mean:         Math.round(row.mean  * 10) / 10,   // 1 decimal place
    stddev:       Math.round(row.stddev * 10) / 10,
    p90:          Math.round(row.p90),
  }
}
