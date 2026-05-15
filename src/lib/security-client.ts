/**
 * HTTP client for dapplepot-security's evaluate endpoint.
 * Replaces the Kafka produce to obs.events.v1 that the security consumer previously read from.
 */

import { env } from '../env.js'
import type { NormalizedEvent } from './session-writer.js'
import { toInternalType } from './session-writer.js'

const SECURITY_EVENTS = new Set([
  'graph_start',   // agent_created equivalent (first session establishes config)
  'graph_end',
  'graph_error',
  'security_finding',
])

export async function forwardToSecurity(event: NormalizedEvent): Promise<void> {
  const internalType = toInternalType(event.sdkEventType)
  if (!SECURITY_EVENTS.has(internalType)) return

  const url = `${env.SECURITY_SERVICE_URL}/v1/evaluate`

  const body = JSON.stringify({
    event_type: internalType,
    session_id: event.sessionId,
    tenant_id: event.tenantId,
    agent_id: event.agentId,
    emitted_at: event.emittedAt,
    payload: event.payload,
  })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_API_SECRET },
      body,
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.error('[security-client] evaluate returned %d for session %s', res.status, event.sessionId)
    }
  } catch (err) {
    console.error('[security-client] failed to forward event to security service:', (err as Error).message)
  }
}
