import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { cached, invalidate } from '../lib/cache.js'
import { redis } from '../lib/redis.js'
import { getRuleList, createRule, updateRule, dryRunRule } from '../queries/rules.pg.js'
import { NotFoundError } from '../types/common.js'

type Variables = { tenantId: string; userId: string }

export const rulesRouter = new Hono<{ Variables: Variables }>()

rulesRouter.use('*', jwtAuth)
rulesRouter.use('*', rateLimitMiddleware)

rulesRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const rules = await cached(
    `dp:api:rules:${tenantId}`,
    60,
    () => getRuleList(tenantId)
  )
  return c.json(rules)
})

rulesRouter.post('/', async (c) => {
  const tenantId = c.get('tenantId')
  const body = await c.req.json<{
    name: string
    ruleType: string
    evalType: string
    enabled: boolean
    config: Record<string, unknown>
    dedupWindowS: number
  }>()

  const threshold = (body.config['threshold'] as number | undefined) ?? 0
  const agentId = (body.config['agentId'] as string | undefined) ?? null

  const [rule, previewSessions] = await Promise.all([
    createRule(tenantId, {
      name: body.name,
      ruleType: body.ruleType,
      evalType: body.evalType,
      enabled: body.enabled,
      config: body.config,
      dedupWindowS: body.dedupWindowS,
    }),
    dryRunRule(tenantId, agentId, threshold),
  ])

  await Promise.all([
    redis.del(`dp:rules:${tenantId}`),
    invalidate(`dp:api:rules:${tenantId}`),
    redis.publish('dp:rule-invalidate', tenantId),
  ])

  return c.json({
    rule,
    preview: {
      wouldHaveFired: previewSessions.length,
      sessions: previewSessions,
    },
  }, 201)
})

rulesRouter.put('/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const ruleId = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    enabled?: boolean
    config?: Record<string, unknown>
    dedupWindowS?: number
  }>()

  const updated = await updateRule(tenantId, ruleId, body)
  if (!updated) throw new NotFoundError(`Rule ${ruleId} not found`)

  await Promise.all([
    redis.del(`dp:rules:${tenantId}`),
    invalidate(`dp:api:rules:${tenantId}`),
    redis.publish('dp:rule-invalidate', tenantId),
  ])

  return c.json(updated)
})
