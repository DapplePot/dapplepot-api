export type ChannelType = 'webhook' | 'slack' | 'pagerduty'

export interface WebhookConfig {
  url: string
  secret?: string
  headers?: Record<string, string>
}

export interface SlackConfig {
  webhookUrl: string
  channel?: string
}

export interface PagerdutyConfig {
  integrationKey: string
  severity?: 'critical' | 'error' | 'warning' | 'info'
}

export type ChannelConfig = WebhookConfig | SlackConfig | PagerdutyConfig

export interface DeliveryChannel {
  channelId: string
  name: string
  channelType: ChannelType
  enabled: boolean
  config: ChannelConfig
  createdAt: string
  updatedAt: string
}
