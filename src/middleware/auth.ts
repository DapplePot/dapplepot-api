import { createMiddleware } from 'hono/factory'
import jwt from 'jsonwebtoken'
const { verify } = jwt
import { createHash } from 'crypto'
import { env } from '../env.js'
import { redis } from '../lib/redis.js'
import { queryRow } from '../lib/postgres.js'

type Variables = {
  tenantId: string
  userId: string
  role: string
}

export const jwtAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } },
      401
    )
  }

  const token = authHeader.slice(7)
  try {
    const payload = verify(token, env.DAPPLEPOT_JWT_SECRET) as {
      tenant_id: string
      user_id: string
      role?: string
      type?: string
    }
    if (payload.type !== undefined && payload.type !== 'access') {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token type' } }, 401)
    }
    c.set('tenantId', payload.tenant_id)
    c.set('userId', payload.user_id)
    c.set('role', payload.role ?? 'viewer')
    await next()
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired JWT' } }, 401)
  }
})

export const sdkKeyAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } },
      401
    )
  }

  const rawKey = authHeader.slice(7)
  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const cacheKey = `dp:auth:${keyHash}`

  let tenantId = await redis.get(cacheKey)
  if (!tenantId) {
    const row = await queryRow<{ tenant_id: string }>(
      'SELECT tenant_id FROM sdk_keys WHERE key_hash = $1 AND enabled = true LIMIT 1',
      [keyHash]
    )
    if (!row) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid or revoked SDK key' } }, 403)
    }
    tenantId = row.tenant_id
    await redis.setex(cacheKey, 60, tenantId)
  }

  c.set('tenantId', tenantId)
  c.set('userId', 'sdk')
  await next()
})

export const internalSecretAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const secret = c.req.header('X-Internal-Secret')
  if (!secret || secret !== env.INTERNAL_API_SECRET) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Forbidden' } }, 401)
  }
  await next()
})
