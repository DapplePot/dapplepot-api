import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { cached } from '../lib/cache.js'
import { stitchOverview } from '../stitchers/overview.js'
import {
  getLlmUsage,
  getErrorRates,
  getLatency,
  getCost,
  getSessionFunnelPg,
  windowToInterval,
} from '../queries/analytics.ch.js'
import { env } from '../env.js'

type Variables = { tenantId: string; userId: string }

export const analyticsRouter = new Hono<{ Variables: Variables }>()

analyticsRouter.use('*', jwtAuth)
analyticsRouter.use('*', rateLimitMiddleware)

analyticsRouter.get('/overview', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '24h'

  const data = await cached(
    `dp:api:overview:${tenantId}:${window}`,
    env.CACHE_TTL_OVERVIEW,
    () => stitchOverview(tenantId, window)
  )

  return c.json(data)
})

analyticsRouter.get('/llm-usage', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '24h'
  const agentId = c.req.query('agentId')

  const data = await cached(
    `dp:api:llm:${tenantId}:${window}:${agentId ?? ''}`,
    env.CACHE_TTL_ANALYTICS,
    () => getLlmUsage(tenantId, window, agentId)
  )

  return c.json(data)
})

analyticsRouter.get('/error-rates', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '24h'
  const agentId = c.req.query('agentId')

  const data = await cached(
    `dp:api:err:${tenantId}:${window}:${agentId ?? ''}`,
    env.CACHE_TTL_ANALYTICS,
    () => getErrorRates(tenantId, window, agentId)
  )

  return c.json(data)
})

analyticsRouter.get('/latency', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '24h'
  const agentId = c.req.query('agentId')

  const data = await cached(
    `dp:api:lat:${tenantId}:${window}:${agentId ?? ''}`,
    env.CACHE_TTL_ANALYTICS,
    () => getLatency(tenantId, window, agentId)
  )

  return c.json(data)
})

analyticsRouter.get('/cost', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '30d'

  const data = await cached(
    `dp:api:cost:${tenantId}:${window}`,
    env.CACHE_TTL_COST,
    () => getCost(tenantId, window)
  )

  return c.json(data)
})

analyticsRouter.get('/sessions/funnel', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '7d'
  const interval = windowToInterval(window)

  const counts = await getSessionFunnelPg(tenantId, interval)
  const completionRate =
    counts.totalStarted > 0 ? counts.completed / counts.totalStarted : 0

  return c.json({ window, ...counts, completionRate })
})
