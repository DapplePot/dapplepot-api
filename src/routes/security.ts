import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { queryRows } from '../lib/postgres.js'
import {
  cached,
  CACHE_TTL_SECURITY_OVERVIEW,
  CACHE_TTL_SESSION_SCORE,
  CACHE_TTL_REMEDIATION,
} from '../lib/cache.js'
import {
  getSecurityOverview, getSessionScore,
  getSessionFindings, getRemediationStats, getTopAgents, getAgentProfile,
  getSignalRegistry,
} from '../queries/security.pg.js'

type Variables = { tenantId: string; userId: string }

export const securityRouter = new Hono<{ Variables: Variables }>()

securityRouter.use('*', jwtAuth)
securityRouter.use('*', rateLimitMiddleware)

// GET /v1/security/overview
securityRouter.get('/overview', async (c) => {
  const tenantId    = c.get('tenantId')
  const windowHours = Number(c.req.query('windowHours') ?? 168)
  const data        = await cached(
    `dp:api:security:overview:${tenantId}:${windowHours}`,
    CACHE_TTL_SECURITY_OVERVIEW,
    () => getSecurityOverview(tenantId, windowHours)
  )
  return c.json(data)
})

// GET /v1/security/sessions/:id/score
securityRouter.get('/sessions/:id/score', async (c) => {
  const tenantId  = c.get('tenantId')
  const sessionId = c.req.param('id')
  const score     = await cached(
    `dp:api:security:score:${tenantId}:${sessionId}`,
    CACHE_TTL_SESSION_SCORE,
    () => getSessionScore(tenantId, sessionId)
  )
  if (!score) return c.json({ error: { code: 'NOT_FOUND', message: 'No score yet' } }, 404)
  return c.json(score)
})

// GET /v1/security/sessions/:id/findings
securityRouter.get('/sessions/:id/findings', async (c) => {
  const tenantId  = c.get('tenantId')
  const sessionId = c.req.param('id')
  const findings  = await getSessionFindings(tenantId, sessionId)
  return c.json({ findings })
})

// GET /v1/security/remediation
securityRouter.get('/remediation', async (c) => {
  const tenantId    = c.get('tenantId')
  const windowHours = Number(c.req.query('windowHours') ?? 168)
  const cards       = await cached(
    `dp:api:security:remediation:${tenantId}:${windowHours}`,
    CACHE_TTL_REMEDIATION,
    () => getRemediationStats(tenantId, windowHours)
  )
  return c.json({ remediation: cards })
})

// GET /v1/security/agents — top agents by composite risk score
securityRouter.get('/agents', async (c) => {
  const tenantId = c.get('tenantId')
  const agents   = await cached(
    `dp:api:security:agents:${tenantId}`,
    CACHE_TTL_SECURITY_OVERVIEW,
    () => getTopAgents(tenantId)
  )
  return c.json({ agents })
})

// GET /v1/security/agents/:id — full security profile for a single agent
securityRouter.get('/agents/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const profile  = await cached(
    `dp:api:security:agent:${tenantId}:${agentId}`,
    CACHE_TTL_SESSION_SCORE,
    () => getAgentProfile(tenantId, agentId),
  )
  if (!profile) return c.json({ error: { code: 'NOT_FOUND', message: 'No security data for this agent' } }, 404)
  return c.json(profile)
})

// GET /v1/security/signals — full signal registry (121 non-excluded sub-checks)
securityRouter.get('/signals', async (c) => {
  const signals = await cached(
    'dp:api:security:signals',
    CACHE_TTL_REMEDIATION,
    () => getSignalRegistry()
  )
  return c.json({ signals })
})

// GET /v1/security/signatures — list tenant's injection signatures
securityRouter.get('/signatures', async (c) => {
  const tenantId = c.get('tenantId')
  const rows = await queryRows(
    `SELECT * FROM injection_signatures
     WHERE (tenant_id = $1 OR tenant_id IS NULL) AND enabled = true
     ORDER BY created_at ASC`,
    [tenantId]
  )
  return c.json({ signatures: rows })
})
