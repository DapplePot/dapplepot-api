// Types for security findings and risk scores.
// Exported via @dapplepot/types so dapplepot_ui can import them directly.

export type RiskBand = 'clean' | 'low' | 'medium' | 'high' | 'critical'

export type ConfidenceTier = 'deterministic' | 'high' | 'medium' | 'low' | 'skeletal'

export type TrustTrend = 'improving' | 'stable' | 'degrading'

/** Per sub-check result within an OW signal (scorer v2+). */
export interface SubCheckStatus {
  status:         'fired' | 'clean'
  score:          number            // raw check_score (0–100)
  effectiveScore?: number           // v3: score × confidence_weight
  confidenceTier?: ConfidenceTier   // v3: deterministic | high | medium | low | skeletal
  label:          string
  detail:         string | null
}

/** Per OW-signal result with sub-check breakdown (scorer v2+). */
export interface OwSignalStatus {
  status:         'fired' | 'clean'
  rawScore:       number                          // max(check_score) of fired sub-checks
  effectiveScore?: number                         // v3: max(check_score × confidence_weight)
  sub_checks:     Record<string, SubCheckStatus>  // keyed by sub_check_id e.g. "PI-01a"
  /** @deprecated use rawScore — kept for v2 payload backward compat */
  score?:         number
}

export interface SessionRiskScore {
  sessionId:              string
  tenantId:               string
  agentId:                string | null
  llmScore:               number          // LLM composite score 0–100
  llmBand:                RiskBand
  asiScore:               number          // ASI composite score 0–100
  asiBand:                RiskBand
  llmSignalStatus:        Record<string, OwSignalStatus> // keyed by "OW-LLM01"
  asiSignalStatus:        Record<string, OwSignalStatus> // keyed by "OW-ASI05"
  // v3 additions
  attackChainsDetected?:  string[]        // e.g. ["indirect_injection_to_exfil"]
  amplification?:         number          // e.g. 1.25 (1.0 = no chain fired)
  confidenceBand?:        string          // "high" | "medium" etc.
  trustScore?:            number          // agent trust score 0–100
  trustTrend?:            TrustTrend
  scorerVersion:          string          // "3.0.0"
  scoredAt:               string          // ISO 8601
}

export interface SecurityFinding {
  findingId:       string
  sessionId:       string
  eventId:         string
  eventType:       string
  framework:       string            // "LLM" | "ASI" — derived from owasp_signal_id
  owaspSignalId:   string            // "OW-LLM01"
  subCheckId:      string            // "PI-01a"
  checkScore:      number            // 0–100 individual sub-check weight
  checkLabel:      string            // "Role-override phrase match"
  category:        string            // "prompt_injection" | "data_disclosure" | etc.
  severity:        'critical' | 'high' | 'medium' | 'low'
  matchedText:     string | null     // always redacted before storage
  detail:          string | null
  detectionPhase:  'online' | 'post_session' | 'cross_session'
  // v3 additions
  confidenceTier?: ConfidenceTier
  confidence?:     number            // 0.0–1.0 (confidence_weight)
  createdAt:       string
}

/** Row from the signal_registry table. */
export interface SignalRegistry {
  owaspSignalId:   string                  // "OW-LLM01"
  subCheckId:      string                  // "PI-01a"
  checkLabel:      string                  // "Role-override phrase match"
  framework:       string                  // "LLM" | "ASI"
  signalNumber:    number                  // 1–20
  category:        string                  // threat category e.g. "prompt_injection"
  detectionPhase:  'online' | 'post_session' | 'both' | 'cross_session' | 'excluded'
  checkScore:      number
  severity:        string
  confidenceTier:  ConfidenceTier          // v3
  excluded:        boolean                 // v3: true = pre-runtime, cannot detect
}

export interface AgentRiskEntry {
  agentId:       string
  sessionCount:  number
  avgLlmScore:   number
  avgAsiScore:   number
  maxLlmScore:   number
  maxAsiScore:   number
  compositeRisk: number
  // v3 trust
  trustScore?:   number
  trustTrend?:   TrustTrend
  lastScoredAt:  string
}

export interface SecurityOverview {
  window:            string
  sessionsScored:    number
  highCriticalCount: number
  avgLlmScore:       number
  topSignalId:       string | null
  topSignalCount:    number
  bandDistribution:  Record<RiskBand, number>
  owaspFrequency:    Array<{ signalId: string; count: number }>
  asiFrequency:      Array<{ signalId: string; count: number }>
  highRiskSessions:  Array<{
    sessionId:       string
    agentId:         string
    llmScore:        number
    llmBand:         RiskBand
    asiScore:        number
    asiBand:         RiskBand
    owaspSignalIds:  string[]
  }>
  topAgents: AgentRiskEntry[]
}

export interface RemediationCard {
  owaspSignalId: string
  title:         string
  description:   string
  fixSteps:      string[]
  sdkSnippet:    string | null   // optional SDK config snippet
  frequency:     number          // how many times this signal fired in the window
}

export interface AgentSignalBreakdown {
  owaspSignalId:    string           // "OW-LLM01" … "OW-ASI10"
  framework:        string           // "LLM" | "ASI"
  firedCount:       number           // total firing events across all sessions
  sessionsAffected: number           // distinct sessions where this signal fired
  lastSeenAt:       string | null    // ISO 8601 or null if never fired
}

export interface AgentRecentSession {
  sessionId: string
  llmScore:  number
  llmBand:   RiskBand
  asiScore:  number
  asiBand:   RiskBand
  scoredAt:  string
}

export interface AgentProfile {
  agentId:         string
  name:            string | null     // from agents table; null if agent not registered
  latestVersion:   string | null
  createdAt:       string | null
  sessionCount:    number
  avgLlmScore:     number
  avgAsiScore:     number
  maxLlmScore:     number
  maxAsiScore:     number
  compositeRisk:   number
  // v3 trust
  trustScore?:     number
  trustTrend?:     TrustTrend
  lastScoredAt:    string | null
  signalBreakdown: AgentSignalBreakdown[]
  recentSessions:  AgentRecentSession[]
}

export type OnlineAction = 'alert' | 'sanitize' | 'block_call' | 'terminate_session'

/** Per-sub-check online detection config (stored in agent_subcheck_overrides JSONB). */
export interface SubCheckOnlineConfig {
  online_detection: boolean
  action:           OnlineAction
}

/** Online detection row — all online findings for a session with their resolved action. */
export interface SessionAction {
  id:               string            // finding_id UUID
  eventId:          string            // event_id that triggered this check
  triggerEventType: string | null     // event_type of the triggering event e.g. "llm_start"
  sessionId:        string
  tenantId:         string
  agentId:          string | null
  subCheckId:       string            // "PI-01a"
  owaspSignalId:    string            // "OW-LLM01"
  checkLabel:       string            // human-readable check name
  severity:         string
  category:         string
  framework:        string            // "LLM" | "ASI"
  matchedText:      string | null     // snippet that triggered the check
  detail:           string | null
  actionTaken:      OnlineAction      // all 5 action types including monitor
  triggeredAt:      string            // ISO 8601
}

export interface InjectionSignature {
  signatureId:  string
  tenantId:     string | null   // null = platform-wide; non-null = tenant-specific
  owaspSignalId: string         // "OW-LLM01"
  patternType:  string          // injection | passthrough | pii | agency | tool_scope
  pattern:      string          // regex or keyword pattern
  description:  string | null
  enabled:      boolean
  createdAt:    string          // ISO 8601
}
