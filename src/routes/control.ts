import { Hono } from 'hono'
import { jwtAuth, sdkKeyAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { redis } from '../lib/redis.js'
import { sendKafkaMessage } from '../lib/kafka.js'
import { queryValue, queryRow } from '../lib/postgres.js'
import { NotFoundError, BadRequestError } from '../types/common.js'

type Variables = { tenantId: string; userId: string }

export const controlRouter = new Hono<{ Variables: Variables }>()

controlRouter.post('/kill-switch', jwtAuth, rateLimitMiddleware, async (c) => {
  const tenantId = c.get('tenantId')
  const { sessionId, reason } = await c.req.json<{ sessionId: string; reason?: string }>()

  const agentId = await queryValue<string>(
    'SELECT agent_id FROM sessions WHERE session_id = $1 AND tenant_id = $2',
    [sessionId, tenantId]
  )
  if (!agentId) throw new NotFoundError(`Session ${sessionId} not found`)

  const cmd = JSON.stringify({ type: 'terminate_session', reason })

  // RPUSH then EXPIRE must be sequential (pipeline) — EXPIRE on a non-existent key is a no-op.
  // Kafka produce runs concurrently with the Redis pipeline.
  const redisKey = `dp:commands:${agentId}`
  await Promise.all([
    redis.pipeline().rpush(redisKey, cmd).expire(redisKey, 3600).exec(),
    sendKafkaMessage('obs.priority.v1', sessionId, {
      event_type: 'kill_switch',
      session_id: sessionId,
      tenant_id: tenantId,
      agent_id: agentId,
      reason,
      ts: new Date().toISOString(),
    }),
  ])

  return c.json({ ok: true })
})

controlRouter.post('/interrupt', jwtAuth, rateLimitMiddleware, async (c) => {
  const tenantId = c.get('tenantId')
  const { sessionId, reason } = await c.req.json<{ sessionId: string; reason?: string }>()

  const row = await queryRow<{ agent_id: string; status: string }>(
    'SELECT agent_id, status FROM sessions WHERE session_id = $1 AND tenant_id = $2',
    [sessionId, tenantId]
  )
  if (!row) throw new NotFoundError(`Session ${sessionId} not found`)
  if (row.status !== 'open') {
    throw new BadRequestError(`Session is ${row.status} — can only interrupt open sessions`)
  }

  await sendKafkaMessage('obs.priority.v1', sessionId, {
    event_type: 'interrupt_requested',
    session_id: sessionId,
    tenant_id: tenantId,
    reason,
    ts: new Date().toISOString(),
  })

  return c.json({ ok: true })
})

controlRouter.get('/commands', sdkKeyAuth, async (c) => {
  const tenantId = c.get('tenantId')
  const agentId = c.req.query('agent_id')

  if (!agentId) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'agent_id required' } }, 400)
  }

  const exists = await queryValue<number>(
    'SELECT 1 FROM sessions WHERE agent_id = $1 AND tenant_id = $2 LIMIT 1',
    [agentId, tenantId]
  )
  if (!exists) return c.json({ commands: [] })

  const redisKey = `dp:commands:${agentId}`
  const raw: string[] = []
  let item: string | null
  while ((item = await redis.lpop(redisKey)) !== null) {
    raw.push(item)
  }

  const commands = raw.map((s) => JSON.parse(s))
  return c.json({ commands })
})
