import { Hono } from 'hono'
import { env } from '../env.js'
import { jwtAuth, sdkKeyAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { queryRows, queryRow } from '../lib/postgres.js'
import { redis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'
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
import { getToolCallBaseline } from '../queries/security.ch.js'
import type { OnlineAction } from '../types/security.js'

const VALID_ACTIONS = new Set<OnlineAction>(['alert', 'sanitize', 'block_call', 'terminate_session'])

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

// GET /v1/security/agents/:id/tool-call-baseline
// Returns 7-day tool-call-per-session statistics from ClickHouse.
// Used by the UI to show the statistical EA-02b baseline alongside the manual cap.
securityRouter.get('/agents/:id/tool-call-baseline', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const baseline = await getToolCallBaseline(tenantId, agentId)
  return c.json(baseline)
})

// GET /v1/security/agents/:id/subcheck-config
// Returns the current per-subcheck online toggle + action map for an agent.
// Shape: { overrides: Record<subCheckId, { online_detection: boolean, action: OnlineAction }> }
securityRouter.get('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const row = await queryRow<{ overrides: unknown }>(
    `SELECT overrides FROM agent_subcheck_overrides
     WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId]
  )
  // sql.unsafe() skips the postgres driver's type parsers — JSONB arrives as a raw
  // JSON string. Parse it here the same way getAgentAlertConfig does.
  let overrides: Record<string, { online_detection: boolean; action: OnlineAction }> = {}
  if (row?.overrides) {
    const raw = row.overrides
    overrides = typeof raw === 'string' ? JSON.parse(raw) : raw as typeof overrides
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

// GET /v1/sdk/security/agents/:id/tool-manifest
// Returns { tool_manifest: string[], max_tool_calls_per_session: number | null }
// Used by the langgraph-sdk to enforce the manifest at tool_start time.
sdkSecurityRouter.get('/agents/:id/tool-manifest', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const config   = await getAgentAlertConfig(tenantId, agentId)
  return c.json({
    tool_manifest:               config.tool_manifest,
    max_tool_calls_per_session:  config.max_tool_calls_per_session,
  })
})

// GET /v1/sdk/security/agents/:id/subcheck-config
sdkSecurityRouter.get('/agents/:id/subcheck-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')
  const row = await queryRow<{ overrides: unknown }>(
    `SELECT overrides FROM agent_subcheck_overrides
     WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId]
  )
  let overrides: Record<string, { online_detection: boolean; action: OnlineAction }> = {}
  if (row?.overrides) {
    const raw = row.overrides
    overrides = typeof raw === 'string' ? JSON.parse(raw) : raw as typeof overrides
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
//   { composite_threshold: number }                           — shared fallback (1–100)
//   { llm_composite_threshold: number | null }                — LLM-only (null = reset)
//   { asi_composite_threshold: number | null }                — ASI-only (null = reset)
//   { signal_id: string, threshold: number | null }           — per-signal (null = reset)
//   { tool_manifest: string[] }                               — allowed tool names for agent
//   { max_tool_calls_per_session: number | null }             — hard cap (null = remove)
// Invalidates Redis config cache after write.
securityRouter.put('/agents/:id/alert-config', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.param('id')

  let body: {
    composite_threshold?:         number
    llm_composite_threshold?:     number | null
    asi_composite_threshold?:     number | null
    signal_id?:                   string
    threshold?:                   number | null
    tool_manifest?:               string[]
    privilege_scope?:             string[]
    tool_approval_policy?:        Record<string, 'always_allow' | 'needs_approval'> | null
    max_tool_calls_per_session?:  number | null
    system_prompt?:               string | null
    environment?:                 'production' | 'staging' | null
    irreversible_tools?:          string[] | null
    network_allowlist?:           string[] | null
    working_directory?:           string | null
    write_namespace?:             string | null
    operating_hours?:             { days: string[]; from: string; to: string } | null
    sbom_allowlist?:              string[] | null
    mcp_endpoints?:               string[] | null
    token_budget_usd?:            number | null
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { composite_threshold, llm_composite_threshold, asi_composite_threshold,
          signal_id, threshold, tool_manifest, privilege_scope, tool_approval_policy,
          max_tool_calls_per_session,
          system_prompt, environment, irreversible_tools, network_allowlist,
          working_directory, write_namespace, operating_hours, sbom_allowlist, mcp_endpoints,
          token_budget_usd } = body

  const isComposite        = composite_threshold !== undefined
  const isLlm              = llm_composite_threshold !== undefined
  const isAsi              = asi_composite_threshold !== undefined
  const isSignal           = signal_id !== undefined
  const isManifest         = tool_manifest !== undefined
  const isPrivilegeScope   = privilege_scope !== undefined
  const isApprovalPolicy   = tool_approval_policy !== undefined
  const isMaxToolCalls     = max_tool_calls_per_session !== undefined
  const isSystemPrompt     = system_prompt !== undefined
  const isEnvironment      = environment !== undefined
  const isIrreversible     = irreversible_tools !== undefined
  const isNetworkAllowlist = network_allowlist !== undefined
  const isWorkingDir       = working_directory !== undefined
  const isWriteNamespace   = write_namespace !== undefined
  const isOperatingHours   = operating_hours !== undefined
  const isSbomAllowlist    = sbom_allowlist !== undefined
  const isMcpEndpoints     = mcp_endpoints !== undefined
  const isTokenBudget      = token_budget_usd !== undefined

  if (!isComposite && !isLlm && !isAsi && !isSignal && !isManifest && !isPrivilegeScope
      && !isApprovalPolicy && !isMaxToolCalls && !isSystemPrompt && !isEnvironment && !isIrreversible
      && !isNetworkAllowlist && !isWorkingDir && !isWriteNamespace && !isOperatingHours
      && !isSbomAllowlist && !isMcpEndpoints && !isTokenBudget) {
    return c.json({ error: 'Provide at least one field to update' }, 400)
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
  if (isManifest) {
    if (!Array.isArray(tool_manifest) || tool_manifest.some(t => typeof t !== 'string')) {
      return c.json({ error: 'tool_manifest must be an array of strings' }, 400)
    }
  }
  if (isPrivilegeScope) {
    if (!Array.isArray(privilege_scope) || privilege_scope.some(t => typeof t !== 'string')) {
      return c.json({ error: 'privilege_scope must be an array of strings' }, 400)
    }
  }
  if (isApprovalPolicy && tool_approval_policy !== null) {
    const VALID_POLICIES = new Set(['always_allow', 'needs_approval'])
    if (typeof tool_approval_policy !== 'object' || Array.isArray(tool_approval_policy)
        || Object.values(tool_approval_policy).some(v => !VALID_POLICIES.has(v))) {
      return c.json({ error: "tool_approval_policy must be null or an object mapping tool names to 'always_allow' | 'needs_approval'" }, 400)
    }
  }
  if (isMaxToolCalls && max_tool_calls_per_session !== null) {
    if (typeof max_tool_calls_per_session !== 'number' || max_tool_calls_per_session < 1) {
      return c.json({ error: 'max_tool_calls_per_session must be a positive integer or null' }, 400)
    }
  }
  if (isSystemPrompt && system_prompt !== null && typeof system_prompt !== 'string') {
    return c.json({ error: 'system_prompt must be a string or null' }, 400)
  }
  if (isEnvironment && environment !== null && environment !== 'production' && environment !== 'staging') {
    return c.json({ error: "environment must be 'production', 'staging', or null" }, 400)
  }
  if (isIrreversible && irreversible_tools !== null) {
    if (!Array.isArray(irreversible_tools) || irreversible_tools.some(t => typeof t !== 'string')) {
      return c.json({ error: 'irreversible_tools must be an array of strings or null' }, 400)
    }
  }
  if (isNetworkAllowlist && network_allowlist !== null) {
    if (!Array.isArray(network_allowlist) || network_allowlist.some(t => typeof t !== 'string')) {
      return c.json({ error: 'network_allowlist must be an array of strings or null' }, 400)
    }
  }
  if (isWorkingDir && working_directory !== null && typeof working_directory !== 'string') {
    return c.json({ error: 'working_directory must be a string or null' }, 400)
  }
  if (isWriteNamespace && write_namespace !== null && typeof write_namespace !== 'string') {
    return c.json({ error: 'write_namespace must be a string or null' }, 400)
  }
  if (isOperatingHours && operating_hours !== null) {
    if (typeof operating_hours !== 'object' || Array.isArray(operating_hours)
        || typeof operating_hours.from !== 'string' || typeof operating_hours.to !== 'string'
        || !Array.isArray(operating_hours.days)) {
      return c.json({ error: 'operating_hours must be { days: string[], from: string, to: string } or null' }, 400)
    }
  }
  if (isSbomAllowlist && sbom_allowlist !== null) {
    if (!Array.isArray(sbom_allowlist) || sbom_allowlist.some(t => typeof t !== 'string')) {
      return c.json({ error: 'sbom_allowlist must be an array of strings or null' }, 400)
    }
  }
  if (isMcpEndpoints && mcp_endpoints !== null) {
    if (!Array.isArray(mcp_endpoints) || mcp_endpoints.some(t => typeof t !== 'string')) {
      return c.json({ error: 'mcp_endpoints must be an array of strings or null' }, 400)
    }
  }
  if (isTokenBudget && token_budget_usd !== null) {
    if (typeof token_budget_usd !== 'number' || token_budget_usd <= 0) {
      return c.json({ error: 'token_budget_usd must be a positive number or null' }, 400)
    }
  }

  await upsertAgentAlertConfig(tenantId, agentId, {
    ...(isComposite        ? { composite_threshold }                            : {}),
    ...(isLlm              ? { llm_composite_threshold }                        : {}),
    ...(isAsi              ? { asi_composite_threshold }                        : {}),
    ...(isSignal           ? { signal_id, signal_threshold: threshold ?? null } : {}),
    ...(isManifest         ? { tool_manifest }                                  : {}),
    ...(isPrivilegeScope   ? { privilege_scope }                                : {}),
    ...(isApprovalPolicy   ? { tool_approval_policy }                           : {}),
    ...(isMaxToolCalls     ? { max_tool_calls_per_session }                     : {}),
    ...(isSystemPrompt     ? { system_prompt }                                  : {}),
    ...(isEnvironment      ? { environment }                                    : {}),
    ...(isIrreversible     ? { irreversible_tools }                             : {}),
    ...(isNetworkAllowlist ? { network_allowlist }                              : {}),
    ...(isWorkingDir       ? { working_directory }                              : {}),
    ...(isWriteNamespace   ? { write_namespace }                                : {}),
    ...(isOperatingHours   ? { operating_hours }                                : {}),
    ...(isSbomAllowlist    ? { sbom_allowlist }                                 : {}),
    ...(isMcpEndpoints     ? { mcp_endpoints }                                  : {}),
    ...(isTokenBudget      ? { token_budget_usd }                               : {}),
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


// POST /v1/sdk/security/online-check
// Proxies the request body to dapplepot-security /v1/online-check and returns
// findings synchronously. SDK key auth only — no JWT required.
// The SDK calls this instead of running detection logic locally.
sdkSecurityRouter.post('/online-check', async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch (err) {
    console.error('[sdk/online-check] failed to parse JSON:', (err as Error).message)
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // Always overwrite tenant_id with the value from the authenticated SDK key — never trust the SDK-supplied value.
  body = { ...body, tenant_id: c.get('tenantId') }

  const url = `${env.SECURITY_SERVICE_URL}/v1/online-check`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_API_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    if (!res.ok) {
      console.warn('[sdk/online-check] security service returned %d', res.status)
      return c.json({ findings: [] }, 200)
    }
    return c.json(data)
  } catch (err) {
    console.error('[sdk/online-check] failed to reach security service at %s:', url, (err as Error).message)
    // fail open — never block the agent if security service is unreachable
    return c.json({ findings: [] }, 200)
  }
})

