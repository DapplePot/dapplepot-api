import { Hono } from 'hono'
import { jwtAuth, sdkKeyAuth } from '../middleware/auth.js'
import { redis } from '../lib/redis.js'
import { queryValue } from '../lib/postgres.js'

type Variables = { tenantId: string; userId: string }

export const controlRouter = new Hono<{ Variables: Variables }>()

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
