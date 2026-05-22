import 'dotenv/config'
import { getChannelList } from './src/queries/channels.pg.js'
import { queryRow, queryRows } from './src/lib/postgres.js'
import { dispatchNotification } from './src/lib/notifications.js'
import type { DeliveryChannel } from './src/types/channel.js'

async function run() {
  try {
    // Fetch all channels configured across all tenants
    const channels = await queryRows<{ channel_id: string, name: string, channel_type: string, enabled: boolean, config: any }>(
      'SELECT * FROM channels WHERE enabled = true'
    )
    const activeChannels = channels.map(c => ({
      channelId: c.channel_id,
      name: c.name,
      channelType: c.channel_type,
      enabled: c.enabled,
      config: typeof c.config === 'string' ? JSON.parse(c.config) : c.config
    }))
    
    if (activeChannels.length === 0) {
      console.log('No active channels found! Please go to http://localhost:5173/detection and add a channel.')
      process.exit(0)
    }

    console.log(`Found ${activeChannels.length} active channels. Triggering test alert...`)

    // 3. Create a mock alert payload
    const mockAlert = {
      alertId: `test_alert_${Date.now()}`,
      title: 'TEST ALERT: Unusual Admin Activity',
      severity: 'critical',
      ruleName: 'Simulated User Event',
      triggeredAt: new Date().toISOString(),
      message: 'This is a simulated alert to test notification delivery channels.'
    }

    // 4. Send the alert to each active channel
    for (const channel of activeChannels) {
      console.log(`\nSending alert to ${channel.channelType} channel ("${channel.name}")...`)
      try {
        await dispatchNotification(channel as DeliveryChannel, mockAlert)
        console.log(`✅ Success! Sent to ${channel.channelType}.`)
      } catch (err) {
        console.error(`❌ Failed to send to ${channel.channelType}:`, err)
      }
    }

    console.log('\nDone.')
    process.exit(0)
  } catch (err) {
    console.error('Error during test:', err)
    process.exit(1)
  }
}

run()
