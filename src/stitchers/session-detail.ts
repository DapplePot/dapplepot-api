import { getSessionPg } from '../queries/sessions.pg.js'
import { getSessionTokensByModel, getSessionEventStats } from '../queries/sessions.ch.js'
import type { SessionDetail } from '../types/session.js'
import { NotFoundError } from '../types/common.js'

export async function stitchSessionDetail(
  tenantId: string,
  sessionId: string
): Promise<SessionDetail> {
  const [pgRow, modelTokens, chStats] = await Promise.all([
    getSessionPg(tenantId, sessionId),
    getSessionTokensByModel(tenantId, sessionId),
    getSessionEventStats(tenantId, sessionId),
  ])

  if (!pgRow) throw new NotFoundError(`Session ${sessionId} not found`)

  const totalInputTokens  = modelTokens.reduce((s, r) => s + Number(r.input_tokens),  0)
  const totalOutputTokens = modelTokens.reduce((s, r) => s + Number(r.output_tokens), 0)
  const llmCallCount      = modelTokens.reduce((s, r) => s + Number(r.call_count),    0)

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
          alertId:     pgRow.last_alert_id,
          severity:    pgRow.last_alert_severity as 'info' | 'warning' | 'critical',
          title:       pgRow.last_alert_title ?? '',
          triggeredAt: pgRow.last_alert_at?.toISOString() ?? '',
        }
      : null,
    tokenUsage: {
      totalInputTokens,
      totalOutputTokens,
      llmCallCount,
      byModel: modelTokens.map(r => ({
        model:        r.llm_model,
        inputTokens:  Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        callCount:    Number(r.call_count),
      })),
    },
    executionSummary: {
      nodeCount:     Number(chStats.node_count),
      errorCount:    Number(chStats.error_count),
      toolCallCount: Number(chStats.tool_calls),
      nodesVisited:  chStats.nodes_visited,
      firstEventAt:  chStats.first_event_at,
      lastEventAt:   chStats.last_event_at,
    },
  }
}
