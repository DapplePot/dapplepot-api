import type { OwSignalStatus } from './security.js'

export type AlertStatus = 'open' | 'acknowledged' | 'resolved'

/** A single finding entry in an alert payload (scorer v2+). */
export interface AlertTopFinding {
  owasp_signal_id: string         // "OW-LLM01"
  sub_check_id:    string         // "PI-01a"
  check_label:     string         // "Role-override phrase match"
  check_score:     number         // 0–100
  severity:        string
  detail:          string | null
}

/** Typed alert payload for security alerts (scorer v2+). */
export interface AlertDetailPayload {
  title?:                   string
  message?:                 string
  rule_type?:               string
  source?:                  'security' | 'policy'
  agent_id?:                string | null
  // Composite risk scores
  llm_score?:               number
  llm_band?:                string
  asi_score?:               number
  asi_band?:                string
  // Per-signal status maps — keyed by OW canonical ID ("OW-LLM01", "OW-ASI03")
  llm_signal_status?:       Record<string, OwSignalStatus>
  asi_signal_status?:       Record<string, OwSignalStatus>
  // Signal summary counts
  summary?: {
    llm_signals_fired?: number
    llm_signals_clean?: number
    asi_signals_fired?: number
    asi_signals_clean?: number
  }
  top_findings?:            AlertTopFinding[]
  signal_taxonomy_version?: string            // "2.0"
  scorer_version?:          string
  [key: string]:            unknown           // allow extra fields
}

export interface AlertSummary {
  alertId:     string
  ruleId:      string | null
  ruleName:    string
  ruleType:    string
  source:      'security' | 'policy'
  sessionId:   string | null
  agentId:     string | null
  severity:    'info' | 'warning' | 'medium' | 'critical'
  title:       string
  message:     string
  status:      AlertStatus
  triggeredAt: string
  resolvedAt:  string | null
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
  dedupKey:  string
  payload:   AlertDetailPayload
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
