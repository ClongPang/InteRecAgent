import type { ConversationEvent, ConversationProjection, Turn, TurnInput } from './types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code)
    this.name = 'ApiError'
  }
}

function headers(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response
  const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null
  throw new ApiError(payload?.error?.code ?? `HTTP_${response.status}`, response.status)
}

export async function createConversation(token: string): Promise<string> {
  const response = await checked(await fetch(`${API_BASE}/api/conversations`, {
    method: 'POST', headers: headers(token), body: '{}',
  }))
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

export async function loadConversation(id: string, token: string): Promise<ConversationProjection> {
  const response = await checked(await fetch(`${API_BASE}/api/conversations/${id}`, { headers: headers(token) }))
  return ((await response.json()) as { projection: ConversationProjection }).projection
}

export async function acceptTurn(
  conversationId: string,
  token: string,
  input: TurnInput,
  expectedRevision: number,
): Promise<Turn> {
  const response = await checked(await fetch(`${API_BASE}/api/conversations/${conversationId}/turns`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ clientTurnId: crypto.randomUUID(), expectedRevision, input }),
  }))
  return ((await response.json()) as { turn: Turn }).turn
}

export async function cancelTurn(conversationId: string, turnId: string, token: string): Promise<void> {
  await checked(await fetch(`${API_BASE}/api/conversations/${conversationId}/turns/${turnId}/cancel`, {
    method: 'POST', headers: headers(token), body: '{}',
  }))
}

export async function retryTurn(conversationId: string, turnId: string, token: string, expectedRevision: number): Promise<Turn> {
  const response = await checked(await fetch(`${API_BASE}/api/conversations/${conversationId}/turns/${turnId}/retry`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ clientTurnId: crypto.randomUUID(), expectedRevision }),
  }))
  return ((await response.json()) as { turn: Turn }).turn
}

function parseFrame(frame: string): ConversationEvent | null {
  const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))
  if (!data) return null
  return JSON.parse(data.slice(5).trim()) as ConversationEvent
}

export async function streamConversation(
  conversationId: string,
  token: string,
  afterSeq: number,
  signal: AbortSignal,
  onEvent: (event: ConversationEvent) => void,
): Promise<number> {
  const response = await checked(await fetch(`${API_BASE}/api/conversations/${conversationId}/events?afterSeq=${afterSeq}`, {
    headers: { authorization: `Bearer ${token}`, 'last-event-id': String(afterSeq) }, signal,
  }))
  if (!response.body) throw new ApiError('SSE_BODY_MISSING', 500)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let cursor = afterSeq
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    frames.forEach((frame) => {
      const event = parseFrame(frame)
      if (!event) return
      cursor = Math.max(cursor, event.seq)
      onEvent(event)
    })
    if (done) return cursor
  }
}
