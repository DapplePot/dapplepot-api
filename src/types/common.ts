export interface Paginated<T> {
  data: T[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface ListParams {
  page?: number
  limit?: number
  sort?: string
  since?: string
  until?: string
}

export interface SessionListParams extends ListParams {
  status?: string
  agentId?: string
  environment?: string
  q?: string
}

export interface AlertListParams extends ListParams {
  severity?: 'info' | 'warning' | 'medium' | 'critical'
  status?: 'open' | 'acknowledged' | 'resolved'
  agentId?: string
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}
