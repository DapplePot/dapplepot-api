import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { env } from './env.js'
import { corsMiddleware } from './middleware/cors.js'
import { mountRoutes } from './routes/index.js'
import { checkPostgres, closePostgres } from './lib/postgres.js'
import { checkClickHouse, closeClickHouse } from './lib/clickhouse.js'
import { checkRedis, closeRedis } from './lib/redis.js'
import { closeKafka } from './lib/kafka.js'
import { NotFoundError, BadRequestError, UnauthorizedError, ForbiddenError } from './types/common.js'

type Variables = { tenantId: string; userId: string }

const app = new Hono<{ Variables: Variables }>()

app.use('*', corsMiddleware)

app.get('/health', async (c) => {
  const [postgres, clickhouse, redis] = await Promise.all([
    checkPostgres().then((ok) => (ok ? 'ok' : 'error')),
    checkClickHouse().then((ok) => (ok ? 'ok' : 'error')),
    checkRedis().then((ok) => (ok ? 'ok' : 'error')),
  ])
  const status = postgres === 'ok' && clickhouse === 'ok' && redis === 'ok' ? 'ok' : 'degraded'
  return c.json({ status, postgres, clickhouse, redis }, status === 'ok' ? 200 : 503)
})

mountRoutes(app)

app.onError((err, c) => {
  if (err instanceof NotFoundError) {
    return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404)
  }
  if (err instanceof BadRequestError) {
    return c.json({ error: { code: 'BAD_REQUEST', message: err.message } }, 400)
  }
  if (err instanceof UnauthorizedError) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, 401)
  }
  if (err instanceof ForbiddenError) {
    return c.json({ error: { code: 'FORBIDDEN', message: err.message } }, 403)
  }
  console.error('[error]', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
})

app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: `Route ${c.req.path} not found` } }, 404)
})

serve(
  { fetch: app.fetch, port: env.API_PORT, hostname: env.API_HOST },
  (info) => {
    console.log(`🚀 dapplepot-api listening on http://${info.address}:${info.port}`)
  }
)

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await Promise.all([closePostgres(), closeClickHouse(), closeRedis(), closeKafka()])
  process.exit(0)
})

export default app
