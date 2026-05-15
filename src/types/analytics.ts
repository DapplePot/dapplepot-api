export interface OverviewMetrics {
  window: string
  totalSessions: number
  liveSessions: number
  completedSessions: number
  errorSessions: number
  totalLlmCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  p95LatencyMs: number
}

export interface LlmUsagePoint {
  hour: string
  llmModel: string
  llmCallCount: number
  totalInputTok: number
  totalOutputTok: number
  avgLatencyMs: number
  p95LatencyMs: number
}

export interface ErrorRatePoint {
  hour: string
  agentId: string
  nodeName: string
  errorCount: number
  totalCount: number
  errorRate: number
}

export interface LatencyStat {
  hour: string
  llmModel: string
  avgMs: number
  p95Ms: number
  callCount: number
}

export interface CostPoint {
  agentId: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

export interface TrendPoint {
  hour: string
  sessionCount: number
  tokenCount: number
  avgLatencyMs: number
}

export interface AgentSessionCount {
  agentId: string
  agentName: string | null
  sessionCount: number
}

export interface SessionFunnel {
  window: string
  totalStarted: number
  open: number
  finalised: number
  terminated: number
  completionRate: number
}
