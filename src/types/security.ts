// Types for security findings and risk scores.
// Exported via @dapplepot/types so dapplepot_ui can import them directly.

export type RiskBand = 'clean' | 'low' | 'medium' | 'high' | 'critical'

export interface SessionRiskScore {
  sessionId:      string
  tenantId:       string
  agentId:        string | null
  riskScore:      number          // 0–100
  riskBand:       RiskBand
  signalCount:    number
  signalIds:      string[]        // ['S-01', 'S-03', 'S-04']
  scorerVersion:  string
  scoredAt:       string          // ISO 8601
}

export interface SecurityFinding {
  findingId:       string
  sessionId:       string
  eventId:         string
  eventType:       string
  signalId:        string         // INJ-001, OUT-001, PII-004, S-06, etc.
  sigType:         string         // injection | passthrough | pii | agency | tool_scope
  owaspId:         string         // LLM01 … LLM10
  severity:        'critical' | 'warning' | 'info'
  matchedText:     string | null  // always redacted before storage
  detail:          string | null
  scoreContrib:    number
  detectionPhase:  'online' | 'post_session'
  createdAt:       string
}

export interface SecurityOverview {
  window:          string
  sessionsScored:  number
  highCriticalCount: number
  avgRiskScore:    number
  topSignalId:     string | null
  topSignalCount:  number
  bandDistribution: Record<RiskBand, number>
  owaspFrequency:  Array<{ owaspId: string; count: number }>
  highRiskSessions: Array<{
    sessionId:  string
    agentId:    string
    riskScore:  number
    riskBand:   RiskBand
    signalIds:  string[]
  }>
}

export interface RemediationCard {
  signalId:    string
  owaspId:     string
  title:       string
  description: string
  fixSteps:    string[]
  sdkSnippet:  string | null    // optional SDK config snippet
  frequency:   number           // how many times this signal fired in the window
}

export interface InjectionSignature {
  signatureId:  string
  tenantId:     string | null   // null = platform-wide; non-null = tenant-specific
  signalId:     string          // INJ-001, PII-004, etc.
  sigType:      string          // injection | passthrough | pii | agency | tool_scope
  owaspId:      string          // LLM01 … LLM10
  pattern:      string          // regex or keyword pattern
  description:  string | null
  enabled:      boolean
  createdAt:    string          // ISO 8601
}
