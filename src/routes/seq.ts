import { Hono } from 'hono'
import { sdkKeyAuth } from '../middleware/auth.js'
import { redis } from '../lib/redis.js'
import { BadRequestError } from '../types/common.js'

type Variables = { tenantId: string; userId: string; role: string }

export const seqRouter = new Hono<{ Variables: Variables }>()

const SEQ_TTL = 90 * 24 * 3600

seqRouter.get('/:sessionId', sdkKeyAuth, async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('sessionId')
  const val = await redis.get(`dp:session:last_seq:${tenantId}:${sessionId}`)
  return c.json({ lastSeq: val !== null ? Number(val) : null })
})

seqRouter.post('/:sessionId', sdkKeyAuth, async (c) => {
  const tenantId = c.get('tenantId')
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json()
  if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < -1) {
    throw new BadRequestError('seq must be >= -1 (-1 = permanently terminated)')
  }
  await redis.set(`dp:session:last_seq:${tenantId}:${sessionId}`, body.seq, 'EX', SEQ_TTL)
  return c.json({ ok: true })
})
