/**
 * CAS (compare-and-swap) upsert for the sessions table.
 * Port of dapplepot-pipeline/consumers/session_writer/upsert.py + state_machine.py + field_patch.py
 *
 * Algorithm:
 *  1. SELECT FOR UPDATE SKIP LOCKED
 *  2. No row → INSERT stub; if locked, skip
 *  3. Stale sequence_index → discard
 *  4. CAS UPDATE (WHERE version = $x)
 *  5. Zero rows → version conflict → retry ≤3× at 50ms
 */

import { sql } from './postgres.js'

const MAX_RETRIES = 3
const RETRY_MS = 50
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

// ── event type mapping (SDK v2 → internal) ───────────────────────────────────

const SDK_TO_INTERNAL: Record<string, string> = {
  session_start: 'graph_start',
  session_end: 'graph_end',
  session_error: 'graph_error',
}

export function toInternalType(sdkType: string): string {
  return SDK_TO_INTERNAL[sdkType] ?? sdkType
}

// ── state machine ─────────────────────────────────────────────────────────────

type Transition = [string, string] // [current_status, event_type]

const TRANSITIONS = new Map<string, string>([
  ['stub|graph_start', 'open'],
  ['open|graph_end',   'finalised'],
  ['open|graph_error', 'terminated'],
  ['stub|graph_end',   'finalised'],  // session_end wins the race before session_start arrives
])

const TERMINAL = new Set(['terminated', 'finalised'])

function nextStatus(current: string, eventType: string): string | null {
  return TRANSITIONS.get(`${current}|${eventType}`) ?? null
}

function isLegalTransition(current: string, eventType: string): boolean {
  if (TERMINAL.has(current)) return false
  const statusChangingTypes = new Set(['graph_start', 'graph_end', 'graph_error'])
  if (statusChangingTypes.has(eventType)) {
    return TRANSITIONS.has(`${current}|${eventType}`)
  }
  return true
}

// ── field patch ───────────────────────────────────────────────────────────────

interface SessionPatch {
  newStatus: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  exitReason: string | null
  agentId: string | null
  agentVersion: string | null
  environment: string | null
  deploymentId: string | null
  userContextId: string | null
  initialInput: object | null
  finalOutput: object | null
  graphState: object | null
  graphRunEntry: object | null
}

function emptyPatch(): SessionPatch {
  return {
    newStatus: null, startedAt: null, endedAt: null, durationMs: null,
    exitReason: null, agentId: null, agentVersion: null, environment: null,
    deploymentId: null, userContextId: null, initialInput: null,
    finalOutput: null, graphState: null, graphRunEntry: null,
  }
}

function buildPatch(
  internalType: string,
  event: NormalizedEvent,
  currentStartedAt: Date | null,
): SessionPatch {
  const p = event.payload
  const emittedAt = event.emittedAt

  switch (internalType) {
    case 'graph_start':
      return {
        ...emptyPatch(),
        newStatus: 'open',
        startedAt: emittedAt,
        agentId: event.agentId,
        agentVersion: event.agentVersion ?? null,
        environment: event.environment ?? null,
        deploymentId: event.deploymentId ?? null,
        userContextId: event.userContextId ?? null,
        initialInput: (p.input as object) ?? null,
        graphRunEntry: { type: 'graph_start', at: emittedAt, run_id: event.runId },
      }

    case 'graph_end': {
      const duration = typeof p.latency_ms === 'number'
        ? p.latency_ms
        : currentStartedAt
          ? Math.round((new Date(emittedAt).getTime() - currentStartedAt.getTime()))
          : null
      return {
        ...emptyPatch(),
        newStatus: 'finalised',
        endedAt: emittedAt,
        durationMs: duration,
        finalOutput: (p.output as object) ?? null,
        graphRunEntry: { type: 'graph_end', at: emittedAt, run_id: event.runId },
      }
    }

    case 'graph_error': {
      const duration = typeof p.latency_ms === 'number'
        ? p.latency_ms
        : currentStartedAt
          ? Math.round((new Date(emittedAt).getTime() - currentStartedAt.getTime()))
          : null
      const errorType = String(p.error_type ?? '')
      const errorMessage = String(p.error_message ?? '')
      const isSecurity = errorType.includes('SecurityViolationError') || errorMessage.includes('SecurityViolationError')
      const exitReason = isSecurity ? 'security_terminated' : 'error'
      return {
        ...emptyPatch(),
        newStatus: 'terminated',
        endedAt: emittedAt,
        durationMs: duration,
        exitReason,
        graphRunEntry: { type: 'graph_error', at: emittedAt, run_id: event.runId, error_type: errorType, error_message: errorMessage, exit_reason: exitReason },
      }
    }

    case 'checkpoint_write':
      return { ...emptyPatch(), graphState: p as object }

    case 'security_finding':
      return {
        ...emptyPatch(),
        graphRunEntry: {
          type: 'security_finding',
          at: emittedAt,
          sub_check_id: p.sub_check_id,
          owasp_signal_id: p.owasp_signal_id,
          check_label: p.check_label,
          severity: p.severity,
          action_taken: p.action_taken,
          category: p.category,
        },
      }

    default:
      return emptyPatch()
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export interface NormalizedEvent {
  eventId: string
  sessionId: string
  runId: string
  tenantId: string
  agentId: string
  agentVersion?: string
  environment?: string
  deploymentId?: string
  userContextId?: string
  sdkEventType: string   // original SDK type (session_start, node_start, …)
  emittedAt: string      // ISO string
  sequenceIndex: number
  payload: Record<string, unknown>
}

export async function upsertEvent(event: NormalizedEvent): Promise<void> {
  const internalType = toInternalType(event.sdkEventType)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Step 1: lock the row
    const rows = await sql.unsafe(
      'SELECT * FROM sessions WHERE session_id = $1 FOR UPDATE SKIP LOCKED',
      [event.sessionId],
    )
    let row = rows[0] as Record<string, unknown> | undefined

    if (!row) {
      // Insert stub; ON CONFLICT DO NOTHING — if locked, RETURNING is empty
      const inserted = await sql.unsafe(
        `INSERT INTO sessions (session_id, tenant_id, agent_id, status, version, last_seq)
         VALUES ($1, $2, $3, 'stub', 1, -1)
         ON CONFLICT (session_id) DO NOTHING
         RETURNING *`,
        [event.sessionId, event.tenantId, event.agentId],
      )
      row = inserted[0] as Record<string, unknown> | undefined
      if (!row) return // locked by another worker
    }

    const currentStatus = row.status as string
    const currentVersion = row.version as number
    const currentStartedAt = row.started_at ? new Date(row.started_at as string) : null
    const lastSeq = row.last_seq as number

    // security_finding events are out-of-band (emitted inline by the SDK interceptor
    // before the buffer flushes session_start). They must not update last_seq or the
    // session_start event (seq=0) would be rejected as a duplicate after last_seq
    // was advanced by the security_finding's copied sequence_index.
    const isOutOfBand = internalType === 'security_finding'
    // graph_end / graph_error are terminal closure events — never drop them on a stale
    // sequence index. When events split across batches the closure event can land in a
    // later batch with batchSeq=0, which would otherwise be < lastSeq from earlier events.
    const isClosingEvent = internalType === 'graph_end' || internalType === 'graph_error'
    if (!isOutOfBand && !isClosingEvent && event.sequenceIndex <= lastSeq) return
    if (!isLegalTransition(currentStatus, internalType)) return

    const patch = buildPatch(internalType, event, currentStartedAt)
    const newSt = nextStatus(currentStatus, internalType)

    // Step 4: CAS UPDATE
    const updated = await sql.unsafe(
      `UPDATE sessions
       SET
         status          = CASE WHEN $1::text IS NOT NULL THEN $1::text ELSE status END,
         started_at      = COALESCE($2::timestamptz, started_at),
         ended_at        = COALESCE($3::timestamptz, ended_at),
         duration_ms     = COALESCE($4::int, duration_ms),
         exit_reason     = COALESCE($5, exit_reason),
         agent_id        = COALESCE($6, agent_id),
         agent_version   = COALESCE($7, agent_version),
         environment     = COALESCE($8, environment),
         deployment_id   = COALESCE($9, deployment_id),
         user_context_id = COALESCE($10, user_context_id),
         initial_input   = COALESCE($11::jsonb, initial_input),
         final_output    = COALESCE($12::jsonb, final_output),
         graph_state     = COALESCE($13::jsonb, graph_state),
         graph_runs      = CASE
                             WHEN $14::jsonb IS NOT NULL
                               THEN graph_runs || jsonb_build_array($14::jsonb)
                             ELSE graph_runs
                           END,
         last_active_at  = $15::timestamptz,
         last_seq        = CASE WHEN $19::boolean THEN last_seq ELSE GREATEST(last_seq, $16) END,
         version         = version + 1,
         updated_at      = now()
       WHERE session_id = $17
         AND version    = $18
       RETURNING version`,
      [
        newSt,
        patch.startedAt,
        patch.endedAt,
        patch.durationMs,
        patch.exitReason,
        patch.agentId,
        patch.agentVersion,
        patch.environment,
        patch.deploymentId,
        patch.userContextId,
        patch.initialInput !== null ? JSON.stringify(patch.initialInput) : null,
        patch.finalOutput !== null ? JSON.stringify(patch.finalOutput) : null,
        patch.graphState !== null ? JSON.stringify(patch.graphState) : null,
        patch.graphRunEntry !== null ? JSON.stringify(patch.graphRunEntry) : null,
        event.emittedAt,
        event.sequenceIndex,
        event.sessionId,
        currentVersion,
        isOutOfBand,
      ],
    )

    if (updated[0]) return // success

    // Version conflict — back off and retry
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, RETRY_MS))
    }
  }

  console.warn('[session-writer] CAS failed after %d retries for session %s', MAX_RETRIES, event.sessionId)
}
