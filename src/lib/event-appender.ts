/**
 * ClickHouse event appender.
 * Port of dapplepot-pipeline/consumers/event_appender/batch.py + extractor.py
 *
 * Writes to obs_events using the 36-column schema.
 * In-process bloom filter dedup over a 60-second rolling window.
 */

import { clickhouse } from './clickhouse.js'
import type { NormalizedEvent } from './session-writer.js'
import { toInternalType } from './session-writer.js'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

// ── hot field extraction ──────────────────────────────────────────────────────

interface HotFields {
  node_name: string
  node_status: string
  llm_model: string
  llm_input_tokens: number
  llm_output_tokens: number
  llm_latency_ms: number
  tool_name: string
  tool_status: string
  tool_latency_ms: number
  error_code: string
  error_message: string
}

const EMPTY_HOT: HotFields = {
  node_name: '', node_status: '',
  llm_model: '', llm_input_tokens: 0, llm_output_tokens: 0, llm_latency_ms: 0,
  tool_name: '', tool_status: '', tool_latency_ms: 0,
  error_code: '', error_message: '',
}

function s(v: unknown): string { return v != null ? String(v) : '' }
function n(v: unknown): number {
  const x = Number(v)
  return isFinite(x) ? Math.round(x) : 0
}

function extractHotFields(sdkType: string, payload: Record<string, unknown>): HotFields {
  const internalType = toInternalType(sdkType)
  switch (internalType) {
    case 'node_start':
      return { ...EMPTY_HOT, node_name: s(payload.node_name), node_status: 'start' }
    case 'node_end':
      return { ...EMPTY_HOT, node_name: s(payload.node_name), node_status: 'end' }
    case 'node_error':
      return { ...EMPTY_HOT, node_name: s(payload.node_name), node_status: 'error', error_code: s(payload.error_type), error_message: s(payload.error_message) }
    case 'llm_start':
      return { ...EMPTY_HOT, llm_model: s(payload.model ?? payload.model_name) }
    case 'llm_end':
      return {
        ...EMPTY_HOT,
        llm_model: s(payload.model ?? payload.model_name),
        llm_input_tokens: n((payload.usage as Record<string, unknown>)?.prompt_tokens ?? payload.prompt_tokens),
        llm_output_tokens: n((payload.usage as Record<string, unknown>)?.completion_tokens ?? payload.completion_tokens),
        llm_latency_ms: n(payload.latency_ms),
      }
    case 'llm_error':
      return { ...EMPTY_HOT, llm_model: s(payload.model ?? payload.model_name), error_code: s(payload.error_type), error_message: s(payload.error_message) }
    case 'tool_start':
      return { ...EMPTY_HOT, tool_name: s(payload.tool_name), tool_status: 'start' }
    case 'tool_end':
      return { ...EMPTY_HOT, tool_name: s(payload.tool_name), tool_status: 'end', tool_latency_ms: n(payload.latency_ms) }
    case 'tool_error':
      return { ...EMPTY_HOT, tool_name: s(payload.tool_name), tool_status: 'error', error_code: s(payload.error_type), error_message: s(payload.error_message) }
    default:
      return { ...EMPTY_HOT }
  }
}

// ── bloom-filter dedup (rotating sets) ───────────────────────────────────────

const DEDUP_WINDOW_MS = 60_000

class RollingDedup {
  private current = new Set<string>()
  private previous = new Set<string>()
  private lastRotate = Date.now()

  has(id: string): boolean {
    this._maybeRotate()
    return this.current.has(id) || this.previous.has(id)
  }

  add(id: string): void {
    this._maybeRotate()
    this.current.add(id)
  }

  private _maybeRotate(): void {
    if (Date.now() - this.lastRotate > DEDUP_WINDOW_MS) {
      this.previous = this.current
      this.current = new Set()
      this.lastRotate = Date.now()
    }
  }
}

const dedup = new RollingDedup()

// ── column order (must match 001_obs_events.sql exactly) ─────────────────────

const COLUMNS = [
  'event_id', 'session_id', 'run_id', 'node_run_id', 'llm_run_id', 'tool_run_id',
  'tenant_id', 'agent_id', 'agent_version', 'environment', 'deployment_id', 'user_context_id',
  'event_type', 'event_category', 'schema_version', 'sdk_version',
  'emitted_at', 'hook_fired_at', 'buffer_wait_ms', 'sequence_index',
  'batch_id', 'batch_index', 'retry_attempt', 'payload',
  'node_name', 'node_status',
  'llm_model', 'llm_input_tokens', 'llm_output_tokens', 'llm_latency_ms',
  'tool_name', 'tool_status', 'tool_latency_ms',
  'error_code', 'error_message',
]

function deriveCategory(internalType: string): string {
  if (internalType.startsWith('graph_')) return 'graph'
  if (internalType.startsWith('node_')) return 'node'
  if (internalType.startsWith('llm_')) return 'llm'
  if (internalType.startsWith('tool_')) return 'tool'
  if (internalType === 'security_finding') return 'security'
  if (internalType === 'checkpoint_write') return 'graph'
  return 'other'
}

function toRow(event: NormalizedEvent, batchId: string, batchIndex: number): unknown[] {
  const internalType = toInternalType(event.sdkEventType)
  const hf = extractHotFields(event.sdkEventType, event.payload)

  return [
    event.eventId,
    event.sessionId,
    event.runId,
    ZERO_UUID,     // node_run_id — not tracked by SDK v2
    ZERO_UUID,     // llm_run_id
    ZERO_UUID,     // tool_run_id
    event.tenantId,
    event.agentId,
    event.agentVersion ?? '',
    event.environment ?? '',
    event.deploymentId ?? '',
    event.userContextId ?? '',
    internalType,
    deriveCategory(internalType),
    '2',           // schema_version
    '',            // sdk_version — not in v2 envelope
    event.emittedAt,
    event.emittedAt,   // hook_fired_at same as emitted_at
    0,             // buffer_wait_ms
    event.sequenceIndex,
    batchId,
    batchIndex,
    0,             // retry_attempt
    JSON.stringify(event.payload),
    hf.node_name,
    hf.node_status,
    hf.llm_model,
    hf.llm_input_tokens,
    hf.llm_output_tokens,
    hf.llm_latency_ms,
    hf.tool_name,
    hf.tool_status,
    hf.tool_latency_ms,
    hf.error_code,
    hf.error_message,
  ]
}

// ── public API ────────────────────────────────────────────────────────────────

export async function appendEvents(events: NormalizedEvent[], batchId: string): Promise<void> {
  const rows: unknown[][] = []
  const newIds: string[] = []

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (dedup.has(e.eventId)) continue
    rows.push(toRow(e, batchId, i))
    newIds.push(e.eventId)
  }

  if (rows.length === 0) return

  await clickhouse.insert({
    table: 'obs_events',
    values: rows,
    columns: COLUMNS,
    format: 'JSONCompactEachRow',
  })

  for (const id of newIds) dedup.add(id)
}
