import type { ApiErrorBody } from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error.message || fallback)
    this.status = status
    this.code = body?.error.code || 'unknown'
    this.retryable = Boolean(body?.error.retryable)
  }
}
