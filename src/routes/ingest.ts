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
    tenantId: String(raw.dp_tenant_id ?? raw.tenant_id ?? tenantId),
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

  // Batch-level idempotency via Redis
  const batchId = String(body.batch_id ?? randomUUID())
  const dedupKey = `dp:batch:${batchId}`
  const isNew = await redis.set(dedupKey, '1', 'NX', 'EX', BATCH_DEDUP_TTL)
  if (!isNew) {
    return c.json({ accepted: rawEvents.length, rejected: 0 }, 202)
  }

  // Normalize events
  const events: NormalizedEvent[] = []
  for (let i = 0; i < rawEvents.length; i++) {
    const normalized = normalize(rawEvents[i] as Record<string, unknown>, tenantId, i)
    if (normalized) events.push(normalized)
  }

  if (events.length === 0) {
    return c.json({ accepted: 0, rejected: rawEvents.length }, 202)
  }

  // Fire-and-forget: fan out to all three destinations without blocking the response
  void processEvents(events, batchId)

  return c.json({ accepted: events.length, rejected: rawEvents.length - events.length }, 202)
})

async function processEvents(events: NormalizedEvent[], batchId: string): Promise<void> {
  // ClickHouse append — bulk insert for the whole batch
  try {
    await appendEvents(events, batchId)
  } catch (err) {
    console.error('[ingest] event-appender failed:', (err as Error).message)
  }

  // Session upsert + security forward — per-event, run in parallel
  await Promise.allSettled(
    events.map(async (event) => {
      await Promise.allSettled([
        upsertEvent(event).catch(e =>
          console.error('[ingest] session-writer failed event %s:', event.eventId, (e as Error).message)
        ),
        forwardToSecurity(event),
      ])
    })
  )
}
