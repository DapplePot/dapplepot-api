export type AlertStatus = 'open' | 'acknowledged' | 'resolved'

export interface AlertSummary {
  alertId: string
  ruleId: string | null
  ruleName: string
  ruleType: string
  sessionId: string | null
  agentId: string | null
  severity: 'info' | 'warning' | 'medium' | 'critical'
  title: string
  message: string
  status: AlertStatus
  triggeredAt: string
  resolvedAt: string | null
}

export interface AlertDelivery {
  deliveryId: string
  channelId: string
  channelName: string
  status: 'pending' | 'delivered' | 'failed'
  attemptCount: number
  lastAttemptedAt: string | null
  deliveredAt: string | null
  errorMessage: string | null
}

export interface AlertDetail extends AlertSummary {
  dedupKey: string
  payload: Record<string, unknown>
  deliveries: AlertDelivery[]
}

export interface AlertStats {
  window: string
  bySeverity: Array<{
    severity: 'info' | 'warning' | 'medium' | 'critical'
    total: number
    open: number
    acknowledged: number
    resolved: number
  }>
  topRules: Array<{
    ruleId: string
    ruleName: string
    count: number
  }>
}
