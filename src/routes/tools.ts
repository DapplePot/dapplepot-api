import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { listTools, createTool, updateToolSchema } from '../queries/tools.pg.js'
import { queryRows } from '../lib/postgres.js'
import { redis } from '../lib/redis.js'

async function invalidateCachesForTool(tenantId: string, toolName: string): Promise<void> {
  const rows = await queryRows<{ agent_id: string }>(
    `SELECT agent_id FROM agent_alert_config
     WHERE tenant_id = $1::uuid AND tool_manifest @> $2::jsonb`,
    [tenantId, JSON.stringify([toolName])]
  )
  await Promise.all(
    rows.map(r => redis.del(`dp:sec:${tenantId}:agent:${r.agent_id}:cfg`))
  )
}

export const toolsRouter = new Hono()

// GET /v1/tools — viewer+
toolsRouter.get('/', jwtAuth, requireRole('viewer'), async (c) => {
  const tenantId = c.get('tenantId')
  const tools = await listTools(tenantId)
  return c.json(tools)
})

// POST /v1/tools — admin only
toolsRouter.post('/', jwtAuth, requireRole('admin'), async (c) => {
  const body = await c.req.json().catch(() => ({}))

  const parsed = z.object({
    name:        z.string().min(1),
    description: z.string().nullable().optional(),
    category:    z.string().nullable().optional(),
    schema:      z.record(z.unknown()).nullable().optional(),
  }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  const tenantId = c.get('tenantId')

  try {
    const tool = await createTool({
      tenantId,
      name:        parsed.data.name,
      description: parsed.data.description ?? null,
      category:    parsed.data.category ?? null,
      schema:      parsed.data.schema ?? null,
    })
    if (tool.schema) {
      await invalidateCachesForTool(tenantId, tool.name)
    }
    return c.json(tool, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('23505') || msg.toLowerCase().includes('unique')) {
      return c.json({ error: { code: 'CONFLICT', message: 'A tool with this name already exists' } }, 409)
    }
    throw err
  }
})

// PATCH /v1/tools/:id — admin only (update schema)
toolsRouter.patch('/:id', jwtAuth, requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId')
  const toolId   = c.req.param('id')
  const body     = await c.req.json().catch(() => ({}))

  const parsed = z.object({
    schema: z.record(z.unknown()).nullable(),
  }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  try {
    const tool = await updateToolSchema(tenantId, toolId, parsed.data.schema)
    await invalidateCachesForTool(tenantId, tool.name)
    return c.json(tool)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('not found') || msg.includes('No rows')) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Tool not found' } }, 404)
    }
    throw err
  }
})
