export type TurnStatus =
  | 'ACCEPTED' | 'CLAIMED' | 'RUNNING' | 'COMMITTING' | 'COMPLETED'
  | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'SUPERSEDED' | 'DEAD_LETTER'

export type QuoteOutcome = 'CHAT' | 'CLARIFICATION' | 'QUOTE_LEADS' | 'NO_QUOTE_LEADS' | 'DEGRADED'

export interface QuoteTarget {
  targetRef: string
  rawText: string
  brand: string | null
  canonicalModel: string
  productType: string | null
  requiredQualifiers: string[]
  conditionPreference: 'NEW' | 'NEW_OR_UNSPECIFIED' | 'REFURBISHED' | 'USED' | 'ANY'
  canonicalQuery: string
  confirmation: 'LEXICALLY_GROUNDED' | 'EXPLICITLY_CONFIRMED'
  normalizationChanges: string[]
}

export interface QuoteLeadPriceRange {
  originalPrice: {
    currency: string
    minAmount: string
    maxAmount: string
  }
  cnyEstimate: {
    minAmount: string
    maxAmount: string
    fxObservedAt: string
    fxExpiresAt: string
  } | null
}

export interface QuoteLead {
  quoteLeadRef: string
  canonicalModel: string
  representativeTitle: string
  condition: 'NEW' | 'REFURBISHED' | 'USED' | 'UNKNOWN'
  merchantLabel: string
  merchantDomain: string
  outboundUrl: string
  priceRanges: QuoteLeadPriceRange[]
  observationCount: number
  firstObservedAt: string
  latestObservedAt: string
}

export interface PublishedQuoteLeadSet {
  contractVersion: 'quote-leads-sg-v1'
  quoteLeadSetRef: string
  targetRef: string
  outcome: 'QUOTE_LEADS' | 'NO_QUOTE_LEADS' | 'DEGRADED'
  reasonCodes: string[]
  providerStatus: 'OK_RESULTS' | 'OK_EMPTY' | 'DEGRADED' | 'FAILED'
  providerFailureCode: string | null
  providerRetryable: boolean | null
  providerContractVersion: string
  leads: QuoteLead[]
  observedAt: string
}

export interface QuoteConversationState {
  contractVersion: 'quote-leads-sg-v1'
  version: number
  target: QuoteTarget | null
  pendingTargetConfirmation: {
    confirmationId: string
    proposal: { rawText: string; proposedModel: string }
    reasonCodes: string[]
    askedByMessageId: string
  } | null
  leadSet: PublishedQuoteLeadSet | null
  displayQuoteLeadRefs: string[]
  excludedQuoteLeadRefs: string[]
  comparisonQuoteLeadRefs: string[]
  focusQuoteLeadRef: string | null
}

export interface QuoteAssistantEnvelope {
  outcome: QuoteOutcome
  addressedOpIds: string[]
  disclosureCodes: Array<'MERCHANT_PAGE_CHECK_REQUIRED' | 'AFFILIATE_LINK_DISCLOSURE' | 'PROVIDER_RESULT_NOT_MARKET_ABSENCE'>
  text: string
}

export interface Message {
  id: string
  seq: number
  role: 'USER' | 'ASSISTANT'
  createdAt: string
  payload: {
    type?: string
    content?: string
    text?: string
    outcome?: QuoteOutcome
    envelope?: QuoteAssistantEnvelope
    [key: string]: unknown
  }
}

export interface Turn {
  id: string
  status: TurnStatus
  attempt: number
  deadlineAt: string
  errorCode: string | null
  createdAt: string
  completedAt?: string | null
}

export interface ConversationProjection {
  conversation: {
    id: string
    status: string
    contractVersion: 'quote-leads-sg-v1'
    currentRevision: number
    createdAt: string
    updatedAt: string
  }
  activeTurn: Turn | null
  latestTurn: Turn | null
  state: {
    revision: number
    status: string
    quote: QuoteConversationState
  }
  messages: Message[]
  latestAssistantMessage: Message | null
  eventCursor: number
}

export type TurnInput = { type: 'MESSAGE'; content: string }

export interface ConversationEvent {
  id: string
  seq: number
  eventType: string
  publicPayload: Record<string, unknown>
  createdAt: string
}
