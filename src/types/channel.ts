export type ChannelType = 'webhook' | 'slack' | 'pagerduty' | 'msteams' | 'email' | 'mobile'

export interface WebhookConfig {
  url: string
  secret?: string
  headers?: Record<string, string>
}

export interface SlackConfig {
  webhookUrl: string
  channel?: string
}

export interface MsteamsConfig {
  webhookUrl: string
}

export interface EmailConfig {
  emailAddress: string
}

export interface MobileConfig {
  phoneNumber: string
}

export interface PagerdutyConfig {
  integrationKey: string
  severity?: 'critical' | 'error' | 'warning' | 'info'
}

export type ChannelConfig = WebhookConfig | SlackConfig | PagerdutyConfig | MsteamsConfig | EmailConfig | MobileConfig

export interface DeliveryChannel {
  channelId: string
  name: string
  channelType: ChannelType
  enabled: boolean
  config: ChannelConfig
  createdAt: string
  updatedAt: string
}
