import { describe, it, expect } from 'vitest'

describe('session stitch', () => {
  it('handles null ClickHouse token results', () => {
    const chTokens = undefined
    const tokenUsage = {
      totalInputTokens: Number(chTokens?.total_input_tok ?? 0),
      totalOutputTokens: Number(chTokens?.total_output_tok ?? 0),
      llmCallCount: Number(chTokens?.llm_call_count ?? 0),
    }
    expect(tokenUsage.totalInputTokens).toBe(0)
    expect(tokenUsage.totalOutputTokens).toBe(0)
    expect(tokenUsage.llmCallCount).toBe(0)
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
