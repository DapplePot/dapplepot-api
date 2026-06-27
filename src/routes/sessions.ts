import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { jwtAuth } from '../middleware/auth.js'
import { requireWritableTenant } from '../middleware/requireWritableTenant.js'
import { requireOnboardingComplete } from '../middleware/requireOnboardingComplete.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { getSessionList, getSessionPg, getLiveSessions, getSessionAlerts } from '../queries/sessions.pg.js'
import { getTracePage, getStateHistory } from '../queries/sessions.ch.js'
import { stitchSessionDetail } from '../stitchers/session-detail.js'
import { NotFoundError } from '../types/common.js'

type Variables = { tenantId: string; userId: string }

export const sessionsRouter = new Hono<{ Variables: Variables }>()

sessionsRouter.use('*', jwtAuth)
sessionsRouter.use('*', requireOnboardingComplete)
sessionsRouter.use('*', requireWritableTenant)
sessionsRouter.use('*', rateLimitMiddleware)

sessionsRouter.get('/live', async (c) => {
  const tenantId = c.get('tenantId')
  return streamSSE(c, async (stream) => {
    while (true) {
      const sessions = await getLiveSessions(tenantId)
      await stream.writeSSE({ event: 'sessions', data: JSON.stringify(sessions) })
      await stream.sleep(2000)
    }
  })
})

sessionsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const q = c.req.query()

  const { sessions, total } = await getSessionList(tenantId, {
    page: q['page'] ? Number(q['page']) : 1,
    limit: q['limit'] ? Number(q['limit']) : 20,
    ...(q['status']      ? { status: q['status'] }           : {}),
    ...(q['agentId']     ? { agentId: q['agentId'] }         : {}),
    ...(q['environment'] ? { environment: q['environment'] } : {}),
    ...(q['since']       ? { since: q['since'] }             : {}),
    ...(q['until']       ? { until: q['until'] }             : {}),
    ...(q['q']           ? { q: q['q'] }                     : {}),
  })

  const limit = Math.min(q['limit'] ? Number(q['limit']) : 20, 100)
  const page = q['page'] ? Number(q['page']) : 1

  return c.json({
    data: sessions,
    total,
    page,
    perPage: limit,
    totalPages: Math.ceil(total / limit),
  })
})

sessionsRouter.get('/:id/trace', async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('id')
  const afterSeq = Number(c.req.query('after_seq') ?? -1)
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 200)

  // Verify session ownership in PG first — an open session may legitimately have
  // zero ClickHouse events yet, so empty trace != 404.
  const pgRow = await getSessionPg(tenantId, sessionId)
  if (!pgRow) throw new NotFoundError(`Session ${sessionId} not found`)

  const tracePage = await getTracePage(tenantId, sessionId, afterSeq, limit)

  return c.json(tracePage)
})

sessionsRouter.get('/:id/state-history', async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('id')
  const history = await getStateHistory(tenantId, sessionId)
  return c.json(history)
})

sessionsRouter.get('/:id/alerts', async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('id')
  const alerts = await getSessionAlerts(tenantId, sessionId)
  return c.json(alerts)
})

sessionsRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('id')
  const detail = await stitchSessionDetail(tenantId, sessionId)

  return c.json(detail)
})
