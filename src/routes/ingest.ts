/**
 * POST /v1/ingest/events
 *
 * Accepts SDK v2 event envelopes and fans out to:
 *   • session-writer  — Postgres sessions CAS upsert
 *   • event-appender  — ClickHouse obs_events insert
 *   • security-client — dapplepot-security HTTP evaluate
 *
 * Replaces the dapplepot-pipeline ingest + Kafka consumers.
 */

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { sdkKeyAuth } from '../middleware/auth.js'
import { redis } from '../lib/redis.js'
import { upsertEvent, type NormalizedEvent } from '../lib/session-writer.js'
import { appendEvents } from '../lib/event-appender.js'
import { forwardToSecurity } from '../lib/security-client.js'

type Variables = { tenantId: string; userId: string; role: string }

export const ingestRouter = new Hono<{ Variables: Variables }>()

const MAX_BATCH = 100
const BATCH_DEDUP_TTL = 3600

// ── normalize SDK v2 envelope → NormalizedEvent ───────────────────────────────

function normalize(
  raw: Record<string, unknown>,
  tenantId: string,
  batchSeq: number,
): NormalizedEvent | null {
  const sdkEventType = String(raw.dp_event_type ?? raw.event_type ?? '')
  const sessionId = String(raw.dp_session_id ?? raw.session_id ?? '')
  const agentId = String(raw.dp_agent_id ?? raw.agent_id ?? tenantId)

  if (!sdkEventType || !sessionId) return null

  return {
    eventId: String(raw.event_id ?? randomUUID()),
    sessionId,
    runId: String(raw.run_id ?? randomUUID()),
    tenantId,
    agentId,
    agentVersion: raw.agent_version as string | undefined,
    environment: raw.environment as string | undefined,
    deploymentId: raw.deployment_id as string | undefined,
    userContextId: raw.user_context_id as string | undefined,
    sdkEventType,
    emittedAt: String(raw.ts ?? raw.emitted_at ?? new Date().toISOString()),
    sequenceIndex: Number(raw.sequence_index ?? batchSeq),
    payload: (raw.payload as Record<string, unknown>) ?? {},
  }
}

// ── route ─────────────────────────────────────────────────────────────────────

ingestRouter.post('/events', sdkKeyAuth, async (c) => {
  const tenantId = c.get('tenantId')

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400)
  }

  const rawEvents = body.events
  if (!Array.isArray(rawEvents)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: "'events' must be an array" } }, 400)
  }
  if (rawEvents.length > MAX_BATCH) {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: `Batch exceeds ${MAX_BATCH} events` } }, 413)
  }

  const batchId = String(body.batch_id ?? randomUUID())

  // Normalize events
  const events: NormalizedEvent[] = []
  for (let i = 0; i < rawEvents.length; i++) {
    const normalized = normalize(rawEvents[i] as Record<string, unknown>, tenantId, i)
    if (normalized) events.push(normalized)
  }

  if (events.length === 0) {
    return c.json({ accepted: 0, rejected: rawEvents.length }, 202)
  }

  // Batch-level idempotency — dedup key is set before the ClickHouse write and
  // released on failure so the SDK can retry the same batch_id.
  const dedupKey = `dp:batch:${batchId}`
  const isNew = await redis.set(dedupKey, '1', 'EX', BATCH_DEDUP_TTL, 'NX')

  if (isNew) {
    // ClickHouse append is awaited before returning so the SDK only sees 202 after
    // events are durably stored. On failure we return 500, which triggers the SDK's
    // built-in retry, and we release the dedup key so the retry is accepted.
    try {
      await appendEvents(events, batchId)
    } catch (err) {
      console.error('[ingest] event-appender failed, releasing dedup key for retry:', (err as Error).message)
      await redis.del(dedupKey)
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Event storage temporarily unavailable' } }, 500)
    }

    // Session upsert + security are fire-and-forget — they don't affect event
    // durability and must not delay the 202 response.
    void postProcessEvents(events)
  }

  return c.json({ accepted: events.length, rejected: rawEvents.length - events.length }, 202)
})

async function postProcessEvents(events: NormalizedEvent[]): Promise<void> {
  // Sequential to preserve state machine ordering within a session
  for (const event of events) {
    await upsertEvent(event).catch(e =>
      console.error('[ingest] session-writer failed event %s:', event.eventId, (e as Error).message)
    )
  }

  // Independent of session state
  await Promise.allSettled(events.map(e => forwardToSecurity(e)))
}
