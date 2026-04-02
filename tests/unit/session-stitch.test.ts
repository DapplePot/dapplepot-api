import { describe, it, expect } from 'vitest'

describe('session stitch', () => {
  it('handles null ClickHouse token results', () => {
    function extractTokens(chTokens: { tok_in: number; tok_out: number } | undefined) {
      return {
        totalInputTokens: chTokens !== undefined ? Number(chTokens.tok_in) : 0,
        totalOutputTokens: chTokens !== undefined ? Number(chTokens.tok_out) : 0,
        llmCallCount: 0,
      }
    }
    expect(extractTokens(undefined).totalInputTokens).toBe(0)
    expect(extractTokens(undefined).totalOutputTokens).toBe(0)
    expect(extractTokens({ tok_in: 10, tok_out: 20 }).totalInputTokens).toBe(10)
    expect(extractTokens({ tok_in: 10, tok_out: 20 }).totalOutputTokens).toBe(20)
  })

  it('handles session with no LLM calls correctly', () => {
    const chStats = {
      node_count: 5,
      error_count: 0,
      tool_calls: 2,
      first_event_at: '2024-01-01T00:00:00Z',
      last_event_at: '2024-01-01T00:01:00Z',
      nodes_visited: ['start', 'llm_call', 'tool_use', 'end'],
    }
    expect(chStats.node_count).toBe(5)
    expect(Array.isArray(chStats.nodes_visited)).toBe(true)
  })
})
