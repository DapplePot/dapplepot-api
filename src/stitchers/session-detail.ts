import { getSessionPg } from '../queries/sessions.pg.js'
import { getSessionTokens, getSessionEventStats } from '../queries/sessions.ch.js'
import type { SessionDetail } from '../types/session.js'
import { NotFoundError } from '../types/common.js'

export async function stitchSessionDetail(
  tenantId: string,
  sessionId: string
): Promise<SessionDetail> {
  const [pgRow, chTokens, chStats] = await Promise.all([
    getSessionPg(tenantId, sessionId),
    getSessionTokens(tenantId, sessionId),
    getSessionEventStats(tenantId, sessionId),
  ])

  if (!pgRow) throw new NotFoundError(`Session ${sessionId} not found`)

  return {
    sessionId: pgRow.session_id,
    status: pgRow.status as SessionDetail['status'],
    agentId: pgRow.agent_id ?? '',
    agentVersion: pgRow.agent_version ?? '',
    environment: pgRow.environment,
    deploymentId: pgRow.deployment_id ?? '',
    userContextId: pgRow.user_context_id ?? '',
    startedAt: pgRow.started_at?.toISOString() ?? null,
    endedAt: pgRow.ended_at?.toISOString() ?? null,
    durationMs: pgRow.duration_ms,
    exitReason: pgRow.exit_reason,
    graphState: pgRow.graph_state,
    initialInput: pgRow.initial_input,
    finalOutput: pgRow.final_output,
    lastAlert: pgRow.last_alert_id
      ? {
          alertId: pgRow.last_alert_id,
          severity: pgRow.last_alert_severity as 'info' | 'warning' | 'critical',
          title: pgRow.last_alert_title ?? '',
          triggeredAt: pgRow.last_alert_at?.toISOString() ?? '',
        }
      : null,
    tokenUsage: {
      totalInputTokens: Number(chTokens?.total_input_tok ?? 0),
      totalOutputTokens: Number(chTokens?.total_output_tok ?? 0),
      llmCallCount: Number(chTokens?.llm_call_count ?? 0),
    },
    executionSummary: {
      nodeCount: Number(chStats.node_count),
      errorCount: Number(chStats.error_count),
      toolCallCount: Number(chStats.tool_calls),
      nodesVisited: chStats.nodes_visited,
      firstEventAt: chStats.first_event_at,
      lastEventAt: chStats.last_event_at,
    },
  }
}
