import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { listMcpServers, createMcpServer, updateMcpServer, deleteMcpServer } from '../queries/mcp-servers.pg.js'

export const mcpServersRouter = new Hono()

// GET /v1/mcp-servers — viewer+
mcpServersRouter.get('/', jwtAuth, requireRole('viewer'), async (c) => {
  const tenantId = c.get('tenantId')
  return c.json(await listMcpServers(tenantId))
})

// POST /v1/mcp-servers — editor+
mcpServersRouter.post('/', jwtAuth, requireRole('editor'), async (c) => {
  const body = await c.req.json().catch(() => ({}))

  const parsed = z.object({
    name:        z.string().min(1),
    url:         z.string().url(),
    description: z.string().nullable().optional(),
  }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  const tenantId = c.get('tenantId')

  try {
    const server = await createMcpServer({
      tenantId,
      name:        parsed.data.name,
      url:         parsed.data.url,
      description: parsed.data.description ?? null,
    })
    return c.json(server, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('23505') || msg.toLowerCase().includes('unique')) {
      return c.json({ error: { code: 'CONFLICT', message: 'An MCP server with this URL is already registered' } }, 409)
    }
    throw err
  }
})

// PATCH /v1/mcp-servers/:id — editor+
mcpServersRouter.patch('/:id', jwtAuth, requireRole('editor'), async (c) => {
  const tenantId = c.get('tenantId')
  const serverId = c.req.param('id')
  const body     = await c.req.json().catch(() => ({}))

  const parsed = z.object({
    name:        z.string().min(1).optional(),
    url:         z.string().url().optional(),
    description: z.string().nullable().optional(),
  }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  try {
    const server = await updateMcpServer(tenantId, serverId, parsed.data)
    return c.json(server)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('not found') || msg.includes('No rows')) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
    }
    if (msg.includes('23505') || msg.toLowerCase().includes('unique')) {
      return c.json({ error: { code: 'CONFLICT', message: 'An MCP server with this URL is already registered' } }, 409)
    }
    throw err
  }
})

// DELETE /v1/mcp-servers/:id — editor+
mcpServersRouter.delete('/:id', jwtAuth, requireRole('editor'), async (c) => {
  const tenantId = c.get('tenantId')
  const serverId = c.req.param('id')

  try {
    await deleteMcpServer(tenantId, serverId)
    return c.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('not found') || msg.includes('No rows')) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
    }
    throw err
  }
})
