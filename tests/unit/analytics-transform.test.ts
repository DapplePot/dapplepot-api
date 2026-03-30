import { describe, it, expect } from 'vitest'
import { windowToHours, windowToDays, windowToInterval } from '../../src/queries/analytics.ch.js'

describe('analytics window helpers', () => {
  it('converts window strings to hours', () => {
    expect(windowToHours('1h')).toBe(1)
    expect(windowToHours('24h')).toBe(24)
    expect(windowToHours('7d')).toBe(168)
    expect(windowToHours('30d')).toBe(720)
  })

  it('converts window strings to days', () => {
    expect(windowToDays('7d')).toBe(7)
    expect(windowToDays('30d')).toBe(30)
  })

  it('converts window strings to intervals', () => {
    expect(windowToInterval('1h')).toBe('1 hour')
    expect(windowToInterval('24h')).toBe('24 hours')
    expect(windowToInterval('7d')).toBe('7 days')
  })

  it('defaults unknown window to 24h', () => {
    expect(windowToHours('unknown')).toBe(24)
  })

  it('handles empty time window gracefully', () => {
    const metrics = {
      totalLlmCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
    }
    expect(metrics.totalLlmCalls).toBe(0)
  })
})
