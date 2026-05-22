import { Hono } from 'hono'
import { internalSecretAuth } from '../middleware/auth.js'
import { getAlertDetail } from '../queries/alerts.pg.js'
import { getChannelList } from '../queries/channels.pg.js'
import { dispatchNotification } from '../lib/notifications.js'
import { queryRow } from '../lib/postgres.js'

type Variables = { tenantId: string; userId: string }

export const internalRouter = new Hono<{ Variables: Variables }>()

internalRouter.use('*', internalSecretAuth)

internalRouter.post('/alerts/deliver', async (c) => {
  const body = await c.req.json<{
    alert_id: string
    tenant_id: string
  }>()

  const { alert_id, tenant_id } = body
  if (!alert_id || !tenant_id) {
    return c.json({ error: 'alert_id and tenant_id required' }, 400)
  }

  // 1. Fetch alert details
  const alert = await getAlertDetail(tenant_id, alert_id)
  if (!alert) {
    return c.json({ error: `Alert ${alert_id} not found` }, 404)
  }

  // 2. Fetch enabled channels for the tenant
  const channels = await getChannelList(tenant_id)
  const activeChannels = channels.filter((ch) => ch.enabled)

  // 3. Dispatch to all active channels
  for (const channel of activeChannels) {
    // Create pending delivery record
    const delivery = await queryRow<{ delivery_id: string }>(
      `INSERT INTO alert_deliveries (alert_id, channel, status, attempt_count, last_attempted_at)
       VALUES ($1, $2, 'pending', 1, NOW())
       RETURNING delivery_id`,
      [alert_id, channel.channelType]
    )

    if (!delivery) continue

    try {
      await dispatchNotification(channel, alert)
      
      // Update on success
      await queryRow(
        `UPDATE alert_deliveries
         SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
         WHERE delivery_id = $1`,
        [delivery.delivery_id]
      )
    } catch (err) {
      // Update on failure
      const errorMsg = err instanceof Error ? err.message : String(err)
      await queryRow(
        `UPDATE alert_deliveries
         SET status = 'failed', error_message = $2, updated_at = NOW()
         WHERE delivery_id = $1`,
        [delivery.delivery_id, errorMsg]
      )
      console.error(`[internal/alerts/deliver] Failed to dispatch to ${channel.channelType}:`, errorMsg)
    }
  }

  return c.json({ success: true, dispatched: activeChannels.length })
})
