import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { listAgents, createAgent } from '../queries/agents.pg.js'

export const agentsRouter = new Hono()

const CreateAgentSchema = z.object({
    name: z.string().min(1, 'name is required'),
    latestVersion: z.string().nullable().optional().default(null),
})

// GET /v1/agents — viewer+
agentsRouter.get('/', jwtAuth, requireRole('viewer'), async (c) => {
    const tenantId = c.get('tenantId')
    const agents = await listAgents(tenantId)
    return c.json(agents)
})

// POST /v1/agents — admin only
agentsRouter.post('/', jwtAuth, requireRole('admin'), async (c) => {
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
            name: parsed.data.name,
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
