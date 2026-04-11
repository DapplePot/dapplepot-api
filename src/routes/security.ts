import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { queryRows, queryRow } from '../lib/postgres.js'
import { redis } from '../lib/redis.js'
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

// GET /v1/security/agents/:id/subcheck-config
// Returns the current per-subcheck online toggle map for an agent.
// Shape: { overrides: Record<subCheckId, { online_detection: boolean }> }
securityRouter.get('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const row = await queryRow<{ overrides: Record<string, { online_detection: boolean }> }>(
    `SELECT overrides FROM agent_subcheck_overrides
     WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId]
  )
  return c.json({ overrides: row?.overrides ?? {} })
})

// PUT /v1/security/agents/:id/subcheck-config
// Body: { subCheckId: string, online_detection: boolean }
// Upserts one sub-check override and invalidates the Redis config cache.
// jwtAuth is already applied router-wide above — no extra role restriction needed.
securityRouter.put('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')

  let body: { subCheckId: string; online_detection: boolean }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { subCheckId, online_detection } = body
  if (!subCheckId || typeof online_detection !== 'boolean') {
    return c.json({ error: 'subCheckId (string) and online_detection (boolean) are required' }, 400)
  }

  // Upsert: merge single key into the JSONB overrides column
  await queryRow(
    `INSERT INTO agent_subcheck_overrides (tenant_id, agent_id, overrides, updated_at)
     VALUES ($1, $2, jsonb_build_object($3::text, jsonb_build_object('online_detection', $4::boolean)), now())
     ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
       overrides   = agent_subcheck_overrides.overrides
                     || jsonb_build_object($3::text, jsonb_build_object('online_detection', $4::boolean)),
       updated_at  = now()`,
    [tenantId, agentId, subCheckId, online_detection]
  )

  // Invalidate the per-agent Redis config cache so the scorer picks up the change
  await redis.del(`dp:sec:${tenantId}:agent:${agentId}:cfg`)

  return c.json({ ok: true, subCheckId, online_detection })
})
