export type RuleType =
  | 'threshold'
  | 'content_match'
  | 'schema_violation'
  | 'state_transition'
  | 'rate'
  | 'cumulative_cost'
  | 'sequence'
  | 'session_duration'

export type EvalType = 'stateless' | 'stateful'

export interface PolicyRule {
  ruleId: string
  tenantId: string
  name: string
  ruleType: RuleType
  evalType: EvalType
  enabled: boolean
  config: Record<string, unknown>
  dedupWindowS: number
  createdAt: string
  updatedAt: string
}

export interface DryRunResult {
  sessionId: string
  value: number
  wouldFire: boolean
}

export interface RulePreview {
  rule: PolicyRule
  preview: {
    wouldHaveFired: number
    sessions: DryRunResult[]
  }
}
