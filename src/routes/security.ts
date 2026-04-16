import { Hono } from 'hono'
import { jwtAuth, sdkKeyAuth } from '../middleware/auth.js'
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
  getSignalRegistry, getAgentAlertConfig, upsertAgentAlertConfig,
  getSessionActions,
} from '../queries/security.pg.js'
import type { OnlineAction } from '../types/security.js'

const VALID_ACTIONS = new Set<OnlineAction>(['alert', 'sanitize', 'terminate_session'])

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
// Returns the current per-subcheck online toggle + action map for an agent.
// Shape: { overrides: Record<subCheckId, { online_detection: boolean, action: OnlineAction }> }
securityRouter.get('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const row = await queryRow<{ overrides: Record<string, { online_detection: boolean; action: OnlineAction }> }>(
    `SELECT overrides FROM agent_subcheck_overrides
     WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId]
  )
  const overrides = row?.overrides ?? {}
  for (const v of Object.values(overrides)) {
    if ((v.action as string) === 'block_call') v.action = 'terminate_session'
  }
  return c.json({ overrides })
})

// ── SDK-facing router (sdkKeyAuth only — no JWT required) ────────────────────
// The langgraph-sdk calls these endpoints from the agent process using an SDK
// write key.  They are mounted separately in index.ts at /v1/sdk/security so
// they bypass the router-wide jwtAuth above.

export const sdkSecurityRouter = new Hono<{ Variables: Variables }>()
sdkSecurityRouter.use('*', sdkKeyAuth)
sdkSecurityRouter.use('*', rateLimitMiddleware)

// GET /v1/sdk/security/agents/:id/subcheck-config
sdkSecurityRouter.get('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const row = await queryRow<{ overrides: Record<string, { online_detection: boolean; action: OnlineAction }> }>(
    `SELECT overrides FROM agent_subcheck_overrides
     WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId]
  )
  const overrides = row?.overrides ?? {}
  // Migrate stale action values stored before the 3-action model
  for (const v of Object.values(overrides)) {
    if ((v.action as string) === 'block_call') v.action = 'terminate_session'
  }
  return c.json({ overrides })
})

// GET /v1/security/agents/:id/alert-config
// Returns composite threshold + per-signal threshold overrides for this agent.
// Absent signals fall back to platform defaults in the scorer.
securityRouter.get('/agents/:id/alert-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const config   = await getAgentAlertConfig(tenantId, agentId)
  return c.json(config)
})

// PUT /v1/security/agents/:id/alert-config
// Accepted body shapes (one per request):
//   { composite_threshold: number }                    — shared fallback (1–100)
//   { llm_composite_threshold: number | null }         — LLM-only (null = reset to default)
//   { asi_composite_threshold: number | null }         — ASI-only (null = reset to default)
//   { signal_id: string, threshold: number | null }    — per-signal (null = reset)
// Invalidates Redis config cache after write.
securityRouter.put('/agents/:id/alert-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')

  let body: {
    composite_threshold?:     number
    llm_composite_threshold?: number | null
    asi_composite_threshold?: number | null
    signal_id?:               string
    threshold?:               number | null
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { composite_threshold, llm_composite_threshold, asi_composite_threshold,
          signal_id, threshold } = body

  const isComposite = composite_threshold !== undefined
  const isLlm       = llm_composite_threshold !== undefined
  const isAsi       = asi_composite_threshold !== undefined
  const isSignal    = signal_id !== undefined

  if (!isComposite && !isLlm && !isAsi && !isSignal) {
    return c.json({ error: 'Provide composite_threshold, llm_composite_threshold, asi_composite_threshold, or signal_id' }, 400)
  }

  if (isComposite) {
    if (typeof composite_threshold !== 'number' || composite_threshold < 1 || composite_threshold > 100) {
      return c.json({ error: 'composite_threshold must be an integer 1–100' }, 400)
    }
  }
  if (isLlm && llm_composite_threshold !== null) {
    if (typeof llm_composite_threshold !== 'number' || llm_composite_threshold < 1 || llm_composite_threshold > 100) {
      return c.json({ error: 'llm_composite_threshold must be 1–100 or null' }, 400)
    }
  }
  if (isAsi && asi_composite_threshold !== null) {
    if (typeof asi_composite_threshold !== 'number' || asi_composite_threshold < 1 || asi_composite_threshold > 100) {
      return c.json({ error: 'asi_composite_threshold must be 1–100 or null' }, 400)
    }
  }
  if (isSignal) {
    if (typeof signal_id !== 'string') {
      return c.json({ error: 'signal_id must be a string' }, 400)
    }
    if (threshold !== undefined && threshold !== null && (typeof threshold !== 'number' || threshold < 0 || threshold > 999)) {
      return c.json({ error: 'threshold must be 0–999 or null' }, 400)
    }
  }

  await upsertAgentAlertConfig(tenantId, agentId, {
    ...(isComposite ? { composite_threshold }                  : {}),
    ...(isLlm       ? { llm_composite_threshold }              : {}),
    ...(isAsi       ? { asi_composite_threshold }              : {}),
    ...(isSignal    ? { signal_id, signal_threshold: threshold ?? null } : {}),
  })

  // Invalidate per-agent Redis config cache so the scorer picks up the change
  await redis.del(`dp:sec:${tenantId}:agent:${agentId}:cfg`)

  return c.json({ ok: true })
})

// PUT /v1/security/agents/:id/subcheck-config
// Body: { subCheckId: string, online_detection: boolean, action?: OnlineAction }
// Upserts one sub-check override (online toggle + action) and invalidates the Redis config cache.
// action defaults to "alert" when omitted.
// jwtAuth is already applied router-wide above — no extra role restriction needed.
securityRouter.put('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')

  let body: { subCheckId: string; online_detection: boolean; action?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { subCheckId, online_detection, action = 'alert' } = body
  if (!subCheckId || typeof online_detection !== 'boolean') {
    return c.json({ error: 'subCheckId (string) and online_detection (boolean) are required' }, 400)
  }
  if (!VALID_ACTIONS.has(action as OnlineAction)) {
    return c.json({ error: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` }, 400)
  }

  // Upsert: merge single key into the JSONB overrides column including action
  await queryRow(
    `INSERT INTO agent_subcheck_overrides (tenant_id, agent_id, overrides, updated_at)
     VALUES ($1, $2,
       jsonb_build_object($3::text,
         jsonb_build_object('online_detection', $4::boolean, 'action', $5::text)
       ), now())
     ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
       overrides   = agent_subcheck_overrides.overrides
                     || jsonb_build_object($3::text,
                          jsonb_build_object('online_detection', $4::boolean, 'action', $5::text)
                        ),
       updated_at  = now()`,
    [tenantId, agentId, subCheckId, online_detection, action]
  )

  // Invalidate the per-agent Redis config cache so the scorer picks up the change
  await redis.del(`dp:sec:${tenantId}:agent:${agentId}:cfg`)

  return c.json({ ok: true, subCheckId, online_detection, action })
})

// GET /v1/security/sessions/:id/actions
// Returns the session_actions audit rows for a session (block_call / terminate_session events).
securityRouter.get('/sessions/:id/actions', async (c) => {
  const tenantId  = c.get('tenantId')
  const sessionId = c.req.param('id')
  const actions   = await getSessionActions(tenantId, sessionId)
  return c.json({ actions })
})
