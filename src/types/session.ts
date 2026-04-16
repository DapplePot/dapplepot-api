export type SessionStatus =
  | 'stub'
  | 'open'
  | 'finalised'
  | 'terminated'

export interface SessionSummary {
  sessionId: string
  status: SessionStatus
  agentId: string | null
  agentVersion: string | null
  environment: string
  deploymentId: string | null
  userContextId: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  lastActiveAt: string | null
  alertCount: number
}

export interface SessionDetail {
  sessionId: string
  status: SessionStatus
  agentId: string
  agentVersion: string
  environment: string
  deploymentId: string
  userContextId: string
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  exitReason: string | null
  graphState: Record<string, unknown> | null
  initialInput: Record<string, unknown> | null
  finalOutput: Record<string, unknown> | null
  lastAlert: {
    alertId: string
    severity: 'info' | 'warning' | 'critical'
    title: string
    triggeredAt: string
  } | null
  tokenUsage: {
    totalInputTokens: number
    totalOutputTokens: number
    llmCallCount: number
  }
  executionSummary: {
    nodeCount: number
    errorCount: number
    toolCallCount: number
    nodesVisited: string[]
    firstEventAt: string | null
    lastEventAt: string | null
  }
}

export interface TraceEvent {
  eventId: string
  eventType: string
  eventCategory: string
  emittedAt: string
  sequenceIndex: number
  nodeRunId: string | null
  llmRunId: string | null
  toolRunId: string | null
  nodeName: string
  nodeStatus: string
  llmModel: string
  llmInputTokens: number
  llmOutputTokens: number
  llmLatencyMs: number
  toolName: string
  toolStatus: string
  errorCode: string
  payload: Record<string, unknown>
}

export interface TracePage {
  sessionId: string
  events: TraceEvent[]
  nextCursor: number | null
  hasNext: boolean
}

export interface StateHistoryEvent {
  eventId: string
  eventType: string
  emittedAt: string
  sequenceIndex: number
  payload: Record<string, unknown>
}

export interface StateHistory {
  sessionId: string
  events: StateHistoryEvent[]
}
