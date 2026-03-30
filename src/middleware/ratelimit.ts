import { createMiddleware } from 'hono/factory'
import { redis } from '../lib/redis.js'

const WINDOW_MS = 60_000     // 1 minute
const MAX_REQUESTS = 300     // per tenant per minute

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  const tenantId = c.get('tenantId') as string | undefined
  if (!tenantId) return next()

  const key = `dp:api:rl:${tenantId}`
  const now = Date.now()
  const windowStart = now - WINDOW_MS

  const pipe = redis.pipeline()
  pipe.zremrangebyscore(key, '-inf', windowStart)
  pipe.zadd(key, now, `${now}-${Math.random()}`)
  pipe.zcard(key)
  pipe.pexpire(key, WINDOW_MS)
  const results = await pipe.exec()

  const count = (results?.[2]?.[1] as number) ?? 0
  if (count > MAX_REQUESTS) {
    return c.json(
      { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
      429
    )
  }

  await next()
})
