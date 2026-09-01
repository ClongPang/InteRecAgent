import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  acceptTurn,
  ApiError,
  cancelTurn,
  createConversation,
  loadConversation,
  retryTurn,
  streamConversation,
} from './client'
import { displayError } from './presentation'
import type { ConversationEvent, ConversationProjection, QuoteLead } from './types'

const TOKEN_KEY = 'interec.quote.auth-token'
const CONVERSATION_KEY = 'interec.quote.conversation-id'
const TERMINAL_FAILURES = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTER'])

function tokenFromEnvironment(): string {
  return (import.meta.env.VITE_AUTH_TOKEN ?? '').trim()
}

export function useQuoteConversation() {
  const [token, setToken] = useState(() => (
    tokenFromEnvironment() || sessionStorage.getItem(TOKEN_KEY) || ''
  ))
  const [tokenDraft, setTokenDraft] = useState('')
  const [conversationId, setConversationId] = useState(() => (
    localStorage.getItem(CONVERSATION_KEY)
  ))
  const [projection, setProjection] = useState<ConversationProjection | null>(null)
  const [composer, setComposer] = useState('')
  const [selectedRefs, setSelectedRefs] = useState<string[]>([])
  const [focusedRef, setFocusedRef] = useState<string | null>(null)
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(token && conversationId))
  const streamCursor = useRef(0)
  const messageEnd = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (id = conversationId, auth = token) => {
    if (!id || !auth) return null
    const next = await loadConversation(id, auth)
    if (next.conversation.contractVersion !== 'quote-leads-sg-v1' || !next.state.quote) {
      throw new Error('CONVERSATION_CONTRACT_MISMATCH')
    }
    setProjection(next)
    setSelectedRefs(next.state.quote.comparisonQuoteLeadRefs)
    streamCursor.current = Math.max(streamCursor.current, next.eventCursor)
    return next
  }, [conversationId, token])

  useEffect(() => {
    if (!conversationId || !token) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    refresh(conversationId, token)
      .catch((failure) => {
        if (!active) return
        if (failure instanceof ApiError && failure.status === 404) {
          localStorage.removeItem(CONVERSATION_KEY)
          setConversationId(null)
          setProjection(null)
        } else {
          setError(displayError(failure))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [conversationId, token, refresh])

  useEffect(() => {
    if (!conversationId || !token) return
    const controller = new AbortController()
    const follow = async () => {
      while (!controller.signal.aborted) {
        try {
          streamCursor.current = await streamConversation(
            conversationId,
            token,
            streamCursor.current,
            controller.signal,
            (event) => {
              streamCursor.current = Math.max(streamCursor.current, event.seq)
              setEvents((current) => [...current, event].slice(-6))
              void refresh(conversationId, token)
                .catch((failure) => setError(displayError(failure)))
            },
          )
        } catch (failure) {
          if (controller.signal.aborted) return
          setError(displayError(failure))
          await new Promise((resolve) => window.setTimeout(resolve, 1_200))
        }
      }
    }
    void follow()
    return () => controller.abort()
  }, [conversationId, token, refresh])

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [projection?.messages.length])

  const quote = projection?.state.quote
  const leadByRef = useMemo(
    () => new Map(quote?.leadSet?.leads.map((lead) => [lead.quoteLeadRef, lead]) ?? []),
    [quote?.leadSet],
  )
  const visibleLeads = quote?.displayQuoteLeadRefs
    .map((ref) => leadByRef.get(ref))
    .filter((lead): lead is QuoteLead => Boolean(lead)) ?? []
  const excludedLeads = quote?.excludedQuoteLeadRefs
    .map((ref) => leadByRef.get(ref))
    .filter((lead): lead is QuoteLead => Boolean(lead)) ?? []
  const focusedLead = focusedRef ? leadByRef.get(focusedRef) ?? null : null
  const running = Boolean(projection?.activeTurn)
  const failedTurn = projection?.latestTurn && TERMINAL_FAILURES.has(projection.latestTurn.status)
    ? projection.latestTurn
    : null

  const ensureConversation = async (): Promise<{ id: string; revision: number }> => {
    if (conversationId && projection) {
      return { id: conversationId, revision: projection.conversation.currentRevision }
    }
    const id = await createConversation(token)
    localStorage.setItem(CONVERSATION_KEY, id)
    setConversationId(id)
    setProjection(await loadConversation(id, token))
    return { id, revision: 0 }
  }

  const sendMessage = async (content: string) => {
    const normalized = content.trim()
    if (!normalized || !token || running) return
    setError(null)
    try {
      const conversation = await ensureConversation()
      await acceptTurn(
        conversation.id,
        token,
        { type: 'MESSAGE', content: normalized },
        conversation.revision,
      )
      await refresh(conversation.id, token)
    } catch (failure) {
      setError(displayError(failure))
    }
  }

  const submitComposer = async () => {
    const text = composer.trim()
    if (!text || running) return
    setComposer('')
    await sendMessage(text)
  }

  const connect = (nextToken: string) => {
    const next = nextToken.trim()
    if (!next) return
    sessionStorage.setItem(TOKEN_KEY, next)
    setToken(next)
    setTokenDraft('')
    setError(null)
  }

  const startNew = () => {
    localStorage.removeItem(CONVERSATION_KEY)
    setConversationId(null)
    setProjection(null)
    setEvents([])
    setSelectedRefs([])
    setFocusedRef(null)
    setError(null)
    streamCursor.current = 0
  }

  const compareSelected = () => {
    if (!quote || selectedRefs.length < 2) return
    const ranks = selectedRefs
      .map((ref) => quote.displayQuoteLeadRefs.indexOf(ref) + 1)
      .filter((rank) => rank > 0)
    void sendMessage(`请比较第 ${ranks.join('、')} 条报价线索，不要重新查询。`)
  }

  const excludeLead = (ref: string) => {
    if (!quote) return
    const rank = quote.displayQuoteLeadRefs.indexOf(ref) + 1
    if (rank > 0) void sendMessage(`排除第 ${rank} 条报价线索，不要重新查询。`)
  }

  const toggleSelected = (ref: string) => {
    setSelectedRefs((current) => current.includes(ref)
      ? current.filter((currentRef) => currentRef !== ref)
      : current.length < 4 ? [...current, ref] : current)
  }

  const retryFailed = async () => {
    if (!projection || !failedTurn) return
    try {
      await retryTurn(
        projection.conversation.id,
        failedTurn.id,
        token,
        projection.conversation.currentRevision,
      )
      await refresh()
    } catch (failure) {
      setError(displayError(failure))
    }
  }

  const cancelActive = async () => {
    if (!projection?.activeTurn) return
    try {
      await cancelTurn(projection.conversation.id, projection.activeTurn.id, token)
      await refresh()
    } catch (failure) {
      setError(displayError(failure))
    }
  }

  return {
    token,
    tokenDraft,
    setTokenDraft,
    connect,
    projection,
    quote,
    composer,
    setComposer,
    selectedRefs,
    focusedRef,
    focusedLead,
    setFocusedRef,
    events,
    error,
    clearError: () => setError(null),
    loading,
    running,
    failedTurn,
    visibleLeads,
    excludedLeads,
    messageEnd,
    sendMessage,
    submitComposer,
    startNew,
    compareSelected,
    excludeLead,
    toggleSelected,
    retryFailed,
    cancelActive,
  }
}

export type QuoteConversationController = ReturnType<typeof useQuoteConversation>
