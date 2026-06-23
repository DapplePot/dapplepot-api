import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { listAgents, createAgent, updateAgent, deleteAgent, getAgentLlmModels, setAgentLlmModels, getAgentConnectedAgents, setAgentConnectedAgents } from '../queries/agents.pg.js'
import { redis } from '../lib/redis.js'

export const agentsRouter = new Hono()

const CreateAgentSchema = z.object({
    name:          z.string().min(1, 'name is required'),
    description:   z.string().nullable().optional().default(null),
    latestVersion: z.string().nullable().optional().default(null),
})

const UpdateAgentSchema = z.object({
    description:   z.string().nullable().optional(),
    latestVersion: z.string().nullable().optional(),
})

// GET /v1/agents — viewer+
agentsRouter.get('/', jwtAuth, requireRole('viewer'), async (c) => {
    const tenantId = c.get('tenantId')
    const agents = await listAgents(tenantId)
    return c.json(agents)
})

// POST /v1/agents — editor+
agentsRouter.post('/', jwtAuth, requireRole('editor'), async (c) => {
    let body: unknown
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = CreateAgentSchema.safeParse(body)
    if (!parsed.success) {
        const first = parsed.error.errors[0]
        return c.json({ error: first?.message ?? 'Validation error' }, 400)
    }

    const tenantId = c.get('tenantId')

    try {
        const agent = await createAgent({
            tenantId,
            name:          parsed.data.name,
            description:   parsed.data.description ?? null,
            latestVersion: parsed.data.latestVersion ?? null,
        })
        return c.json(agent, 201)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('23505') || msg.includes('unique') || msg.toLowerCase().includes('duplicate')) {
            return c.json({ error: 'An agent with this name already exists' }, 409)
        }
        return c.json({ error: 'Internal server error' }, 500)
    }
})

// PATCH /v1/agents/:id — editor+
agentsRouter.patch('/:id', jwtAuth, requireRole('editor'), async (c) => {
    const tenantId = c.get('tenantId')
    const agentId  = c.req.param('id')

    let body: unknown
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = UpdateAgentSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }, 400)
    }

    const agent = await updateAgent({
        tenantId,
        agentId,
        description:   parsed.data.description,
        latestVersion: parsed.data.latestVersion,
    })
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    return c.json(agent)
})

// DELETE /v1/agents/:id — editor+
agentsRouter.delete('/:id', jwtAuth, requireRole('editor'), async (c) => {
    const tenantId = c.get('tenantId')
    const agentId  = c.req.param('id')
    await deleteAgent(tenantId, agentId)
    return c.body(null, 204)
})

// GET /v1/agents/:id/llm-models — viewer+
agentsRouter.get('/:id/llm-models', jwtAuth, requireRole('viewer'), async (c) => {
    const tenantId = c.get('tenantId')
    const agentId  = c.req.param('id')
    const models   = await getAgentLlmModels(tenantId, agentId)
    return c.json(models)
})

// PUT /v1/agents/:id/llm-models — editor+
agentsRouter.put('/:id/llm-models', jwtAuth, requireRole('editor'), async (c) => {
    const tenantId = c.get('tenantId')
    const agentId  = c.req.param('id')
    const body     = await c.req.json().catch(() => ({}))

    const parsed = z.object({ modelIds: z.array(z.string().uuid()) }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
    }

    await setAgentLlmModels(tenantId, agentId, parsed.data.modelIds)
    // Invalidate the security scorer's Redis cache so EA-04a and UBC-01b
    // see the updated connected_llms list on the very next session.
    await redis.del(`dp:sec:${tenantId}:agent:${agentId}:cfg`)
    const models = await getAgentLlmModels(tenantId, agentId)
    return c.json(models)
})

// GET /v1/agents/:id/connected-agents — viewer+
agentsRouter.get('/:id/connected-agents', jwtAuth, requireRole('viewer'), async (c) => {
    const tenantId = c.get('tenantId')
    const agentId  = c.req.param('id')
    const agents   = await getAgentConnectedAgents(tenantId, agentId)
    return c.json(agents)
})

// PUT /v1/agents/:id/connected-agents — editor+
agentsRouter.put('/:id/connected-agents', jwtAuth, requireRole('editor'), async (c) => {
    const tenantId = c.get('tenantId')
    const agentId  = c.req.param('id')
    const body     = await c.req.json().catch(() => ({}))

    const parsed = z.object({ agentIds: z.array(z.string().uuid()) }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
    }

    await setAgentConnectedAgents(tenantId, agentId, parsed.data.agentIds)
    // Invalidate the security scorer's Redis cache so IAC-05a sees the
    // updated connected_agents list on the very next session.
    await redis.del(`dp:sec:${tenantId}:agent:${agentId}:cfg`)
    const agents = await getAgentConnectedAgents(tenantId, agentId)
    return c.json(agents)
})
