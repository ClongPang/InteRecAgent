import { getAnonymousUserId } from '../lib/anonymousUser'
import { ApiError } from './errors'
import type { ApiErrorBody } from './types'

export function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')
}

export function authHeaders(): HeadersInit {
  return { 'X-Anonymous-User-ID': getAnonymousUserId() }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('X-Anonymous-User-ID', getAnonymousUserId())
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers })
  if (response.status === 204) return undefined as T
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new ApiError(response.status, data as ApiErrorBody, `请求失败（${response.status}）`)
  }
  return data as T
}
