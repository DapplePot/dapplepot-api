import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { getChannelList, createChannel, updateChannel, deleteChannel } from '../queries/channels.pg.js'
import { NotFoundError } from '../types/common.js'

type Variables = { tenantId: string; userId: string }

export const channelsRouter = new Hono<{ Variables: Variables }>()

channelsRouter.use('*', jwtAuth)
channelsRouter.use('*', rateLimitMiddleware)

channelsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const channels = await getChannelList(tenantId)
  return c.json(channels)
})

channelsRouter.post('/', async (c) => {
  const tenantId = c.get('tenantId')
  const body = await c.req.json<{
    name: string
    channelType: string
    enabled: boolean
    config: Record<string, unknown>
  }>()

  const channel = await createChannel(tenantId, body)
  return c.json(channel, 201)
})

channelsRouter.put('/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const channelId = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    enabled?: boolean
    config?: Record<string, unknown>
  }>()

  const updated = await updateChannel(tenantId, channelId, body)
  if (!updated) throw new NotFoundError(`Channel ${channelId} not found`)
  return c.json(updated)
})

channelsRouter.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const channelId = c.req.param('id')

  const deleted = await deleteChannel(tenantId, channelId)
  if (!deleted) throw new NotFoundError(`Channel ${channelId} not found`)
  return c.json({ success: true })
})
