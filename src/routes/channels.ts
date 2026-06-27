import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { requireWritableTenant } from '../middleware/requireWritableTenant.js'
import { requireOnboardingComplete } from '../middleware/requireOnboardingComplete.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { getChannelList, createChannel, updateChannel, deleteChannel } from '../queries/channels.pg.js'
import { getCurrentPlan } from '../queries/billing.pg.js'
import { NotFoundError } from '../types/common.js'

type Variables = { tenantId: string; userId: string }

export const channelsRouter = new Hono<{ Variables: Variables }>()

channelsRouter.use('*', jwtAuth)
channelsRouter.use('*', requireOnboardingComplete)
channelsRouter.use('*', requireWritableTenant)
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

  // Plan-tier channel-type gate. Note: 'email' and 'mobile' channel types
  // exist in the DB enum but are intentionally absent from allowedChannels
  // for every tier in v1 (handlers preserved server-side, UI hidden).
  const plan = await getCurrentPlan(tenantId)
  if (plan) {
    const allowed = plan.limits.allowedChannels as readonly string[]
    if (!allowed.includes(body.channelType)) {
      return c.json(
        {
          error: {
            code:             'CHANNEL_TYPE_NOT_AVAILABLE',
            message:          `Channel type "${body.channelType}" is not available on the ${plan.limits.displayName} plan.`,
            channel_type:     body.channelType,
            current_plan:     plan.planTier,
            allowed_channels: allowed,
            upgrade_url:      '/upgrade',
          },
        },
        403
      )
    }
  }

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
