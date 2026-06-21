import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import {
  getAlertList,
  getAlertDetail,
  updateAlertStatus,
  getAlertStats,
} from '../queries/alerts.pg.js'
import { windowToInterval } from '../queries/analytics.ch.js'
import { NotFoundError } from '../types/common.js'

type Variables = { tenantId: string; userId: string }

export const alertsRouter = new Hono<{ Variables: Variables }>()

alertsRouter.use('*', jwtAuth)
alertsRouter.use('*', rateLimitMiddleware)

alertsRouter.get('/stats', async (c) => {
  const tenantId = c.get('tenantId')
  const window = c.req.query('window') ?? '24h'
  const interval = windowToInterval(window)
  const stats = await getAlertStats(tenantId, interval)
  return c.json({ ...stats, window })
})

alertsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const q = c.req.query()

  const { alerts, total } = await getAlertList(tenantId, {
    page: q['page'] ? Number(q['page']) : 1,
    limit: q['limit'] ? Number(q['limit']) : 20,
    ...(q['severity'] ? { severity: q['severity'] as 'info' | 'warning' | 'medium' | 'critical' } : {}),
    ...(q['status']   ? { status: q['status'] as 'open' | 'acknowledged' | 'resolved' }           : {}),
    ...(q['agentId']  ? { agentId: q['agentId'] } : {}),
    ...(q['since']    ? { since: q['since'] }     : {}),
    ...(q['until']    ? { until: q['until'] }     : {}),
  })

  const limit = Math.min(q['limit'] ? Number(q['limit']) : 20, 100)
  const page = q['page'] ? Number(q['page']) : 1

  return c.json({
    data: alerts,
    total,
    page,
    perPage: limit,
    totalPages: Math.ceil(total / limit),
  })
})

alertsRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const alertId = c.req.param('id')
  const detail = await getAlertDetail(tenantId, alertId)
  if (!detail) throw new NotFoundError(`Alert ${alertId} not found`)
  return c.json(detail)
})

// New route to fetch only deliveries for an alert
alertsRouter.get('/:id/deliveries', async (c) => {
  const tenantId = c.get('tenantId')
  const alertId = c.req.param('id')
  const detail = await getAlertDetail(tenantId, alertId)
  if (!detail) throw new NotFoundError(`Alert ${alertId} not found`)
  return c.json({ deliveries: detail.deliveries ?? [] })
})

alertsRouter.put('/:id/status', async (c) => {
  const tenantId = c.get('tenantId')
  const alertId = c.req.param('id')
  const body = await c.req.json<{ status: 'open' | 'acknowledged' | 'resolved' }>()

  if (!['open', 'acknowledged', 'resolved'].includes(body.status)) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid status value' } },
      400
    )
  }

  const result = await updateAlertStatus(tenantId, alertId, body.status)
  if (!result) throw new NotFoundError(`Alert ${alertId} not found`)
  return c.json(result)
})
