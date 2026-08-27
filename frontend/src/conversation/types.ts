export type TurnStatus =
  | 'ACCEPTED' | 'CLAIMED' | 'RUNNING' | 'COMMITTING' | 'COMPLETED'
  | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'SUPERSEDED' | 'DEAD_LETTER'

export interface Candidate {
  offerRef: string
  title: string
  canonicalModel: string | null
  categoryId: string
  itemRole: string
  condition: string
  retrievalMarket: string
  merchant: string
  cnyAmount: string
  stock: string
  claimIds: string[]
  marketEvidenceLevel?: string
  rankingReasonCodes?: string[]
  discovery?: {
    supportLevel: 'DISCOVERY' | 'VERIFIED'
    identityLevel: 'OFFER_ONLY' | 'VERIFIED_ITEM'
    identityKey: string | null
    matchedPreferenceKeys: string[]
    contradictedPreferenceKeys: string[]
    rankVector: {
      eligibilityTier: number
      targetCoverage: number
      positiveCoverage: number
      negativeConflicts: number
      evidenceTier: number
      stockTier: number
      priceTieBreaker: string | null
    }
  }
}

export interface Goal {
  target: { categoryId: string; targetText?: string; canonicalModel: string | null; itemRole: string; condition: string } | null
  budget: { amount: string; currency: string } | null
  retrievalMarkets: string[]
  deliveryDestination: string | null
  stockPreference: 'ANY' | 'KNOWN_IN_STOCK'
  hardConstraints: Array<{ key: string; operator: string; value: unknown }>
  preferences: Array<{ key: string; value: unknown; weight: number }>
  exclusions: Array<{ kind: string; value: string }>
  unresolved: Array<{ slotId: string; reasonCodes: string[] }>
}

export interface Claim {
  claimId: string
  kind: string
  renderedText: string
  canonicalValue: unknown
  offerRefs: string[]
  evidenceRefs: Array<{ artifactRef: string; source: string; observedAt: string; jsonPath: string }>
}

export interface AssistantEnvelope {
  outcome: 'CHAT' | 'CLARIFICATION' | 'DISCOVERY' | 'RECOMMENDATION' | 'NO_MATCH' | 'DEGRADED'
  blocks: Array<
    | { type: 'TRANSITION'; text: string }
    | { type: 'CLAIM'; claimId: string }
    | { type: 'COMPARISON'; claimIds: string[] }
    | { type: 'QUESTION'; slotId: string; wording: string }
    | { type: 'DISCLOSURE'; disclosureCode: string }
  >
  nextMoves: Array<{ id: string; label: string; operation: Record<string, unknown> }>
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
    outcome?: string
    envelope?: AssistantEnvelope
    claimLedger?: { claims: Claim[] }
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
  conversation: { id: string; status: string; currentRevision: number; createdAt: string; updatedAt: string }
  activeTurn: Turn | null
  latestTurn: Turn | null
  state: {
    revision: number
    goalRevision: { version: number; goal: Goal } | null
    dialogue: {
      pendingClarification: { slotId: string; askedByMessageId: string } | null
      focusOfferRef: string | null
      comparisonOfferRefs: string[]
    }
    workingSet: {
      version: number
      pool: Candidate[]
      displayOfferRefs: string[]
      mentionedOfferRefs: string[]
      comparisonOfferRefs: string[]
      rejectedOfferRefs: string[]
      focusOfferRef: string | null
    } | null
  }
  messages: Message[]
  latestAssistantMessage: Message | null
  eventCursor: number
}

export type TurnInput =
  | { type: 'MESSAGE'; content: string; focusOfferRef?: string }
  | { type: 'PATCH_GOAL'; operations: Record<string, unknown>[] }
  | { type: 'UNDO'; revision: number }
  | { type: 'SET_COMPARISON'; offerRefs: string[] }

export interface ConversationEvent {
  id: string
  seq: number
  eventType: string
  publicPayload: Record<string, unknown>
  createdAt: string
}
