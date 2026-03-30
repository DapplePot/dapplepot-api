import { chQuery, chQueryRow } from '../lib/clickhouse.js'
import type { TraceEvent, TracePage, StateHistory, StateHistoryEvent } from '../types/session.js'

interface TokenTotals {
  total_input_tok: number
  total_output_tok: number
  llm_call_count: number
}

interface EventStats {
  node_count: number
  error_count: number
  tool_calls: number
  first_event_at: string | null
  last_event_at: string | null
  nodes_visited: string[]
}

export async function getSessionTokens(
  tenantId: string,
  sessionId: string
): Promise<TokenTotals | undefined> {
  return chQueryRow<TokenTotals>(
    `SELECT
      sum(total_input_tok)  AS total_input_tok,
      sum(total_output_tok) AS total_output_tok,
      sum(llm_call_count)   AS llm_call_count
    FROM obs_session_tokens
    FINAL
    WHERE tenant_id  = {tenantId: String}
      AND session_id = {sessionId: UUID}`,
    { tenantId, sessionId }
  )
}

export async function getSessionEventStats(
  tenantId: string,
  sessionId: string
): Promise<EventStats> {
  const row = await chQueryRow<EventStats>(
    `SELECT
      countIf(event_type = 'node_start')   AS node_count,
      countIf(event_type LIKE '%_error')   AS error_count,
      countIf(event_type = 'tool_end')     AS tool_calls,
      min(emitted_at)                      AS first_event_at,
      max(emitted_at)                      AS last_event_at,
      groupArray(DISTINCT node_name)       AS nodes_visited
    FROM obs_events
    WHERE tenant_id  = {tenantId: String}
      AND session_id = {sessionId: UUID}`,
    { tenantId, sessionId }
  )
  return row ?? {
    node_count: 0,
    error_count: 0,
    tool_calls: 0,
    first_event_at: null,
    last_event_at: null,
    nodes_visited: [],
  }
}

export async function getTracePage(
  tenantId: string,
  sessionId: string,
  afterSeq: number,
  limit: number
): Promise<TracePage> {
  const fetchLimit = Math.min(limit, 200)
  const rows = await chQuery<{
    event_id: string
    event_type: string
    event_category: string
    emitted_at: string
    sequence_index: number
    node_run_id: string | null
    llm_run_id: string | null
    tool_run_id: string | null
    node_name: string
    node_status: string
    llm_model: string
    llm_input_tokens: number
    llm_output_tokens: number
    llm_latency_ms: number
    tool_name: string
    tool_status: string
    error_code: string
    payload: string
  }>(
    `SELECT
      event_id, event_type, event_category, emitted_at,
      sequence_index, node_run_id, llm_run_id, tool_run_id,
      node_name, node_status, llm_model,
      llm_input_tokens, llm_output_tokens, llm_latency_ms,
      tool_name, tool_status, error_code,
      payload
    FROM obs_events
    WHERE tenant_id      = {tenantId: String}
      AND session_id     = {sessionId: UUID}
      AND sequence_index > {afterSeq: UInt32}
    ORDER BY sequence_index ASC
    LIMIT {limit: UInt32}`,
    { tenantId, sessionId, afterSeq, limit: fetchLimit + 1 }
  )

  const hasNext = rows.length > fetchLimit
  const events = (hasNext ? rows.slice(0, fetchLimit) : rows).map((r): TraceEvent => ({
    eventId: r.event_id,
    eventType: r.event_type,
    eventCategory: r.event_category,
    emittedAt: r.emitted_at,
    sequenceIndex: r.sequence_index,
    nodeRunId: r.node_run_id,
    llmRunId: r.llm_run_id,
    toolRunId: r.tool_run_id,
    nodeName: r.node_name,
    nodeStatus: r.node_status,
    llmModel: r.llm_model,
    llmInputTokens: r.llm_input_tokens,
    llmOutputTokens: r.llm_output_tokens,
    llmLatencyMs: r.llm_latency_ms,
    toolName: r.tool_name,
    toolStatus: r.tool_status,
    errorCode: r.error_code,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload as Record<string, unknown>),
  }))

  const lastEvent = events[events.length - 1]
  return {
    sessionId,
    events,
    nextCursor: hasNext && lastEvent ? lastEvent.sequenceIndex : null,
    hasNext,
  }
}

export async function getStateHistory(
  tenantId: string,
  sessionId: string
): Promise<StateHistory> {
  const rows = await chQuery<{
    event_id: string
    event_type: string
    emitted_at: string
    sequence_index: number
    payload: string
  }>(
    `SELECT
      event_id, event_type, emitted_at, sequence_index, payload
    FROM obs_events
    WHERE tenant_id  = {tenantId: String}
      AND session_id = {sessionId: UUID}
      AND event_type IN ('checkpoint_write', 'interrupt_raised', 'interrupt_resumed')
    ORDER BY sequence_index ASC`,
    { tenantId, sessionId }
  )

  const events: StateHistoryEvent[] = rows.map((r) => ({
    eventId: r.event_id,
    eventType: r.event_type,
    emittedAt: r.emitted_at,
    sequenceIndex: r.sequence_index,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload as Record<string, unknown>),
  }))

  return { sessionId, events }
}
