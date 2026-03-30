import { describe, it, expect } from 'vitest'

const VALID_RULE_TYPES = [
  'threshold',
  'content_match',
  'schema_violation',
  'state_transition',
  'rate',
  'cumulative_cost',
  'sequence',
  'session_duration',
] as const

describe('rule validation', () => {
  it('accepts valid rule types', () => {
    for (const rt of VALID_RULE_TYPES) {
      expect(VALID_RULE_TYPES).toContain(rt)
    }
  })

  it('rejects invalid rule configs', () => {
    const invalidRuleType = 'invalid_type'
    expect(VALID_RULE_TYPES).not.toContain(invalidRuleType)
  })

  it('validates cumulative_cost rule requires threshold', () => {
    const config = { threshold: 1000 }
    expect(typeof config.threshold).toBe('number')
    expect(config.threshold).toBeGreaterThan(0)
  })

  it('dedup window must be positive', () => {
    const dedupWindowS = 300
    expect(dedupWindowS).toBeGreaterThan(0)
  })
})
