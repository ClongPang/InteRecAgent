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
  ranking?: {
    validationMode: 'SEARCH_ONLY' | 'RULE_VALIDATED'
    identityResolution: 'LISTING_LEVEL' | 'MODEL_RESOLVED'
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

export type ClarificationKind =
  | 'BUDGET' | 'PURCHASE_MARKET' | 'TARGET_PRODUCT' | 'TARGET_MODEL' | 'CONDITION'
  | 'DELIVERY_DESTINATION' | 'QUANTITY' | 'FORM_FACTOR' | 'CANDIDATE_REFERENT' | 'TURN_REPHRASE'

export interface ClarificationIntent {
  kind: ClarificationKind
  contextRef?: string
}

export interface AssistantEnvelope {
  outcome: 'CHAT' | 'CLARIFICATION' | 'SEARCH_RESULTS' | 'RECOMMENDATION' | 'NO_MATCH' | 'DEGRADED'
  blocks: Array<
    | { type: 'TRANSITION'; text: string }
    | { type: 'CLAIM'; claimId: string }
    | { type: 'COMPARISON'; claimIds: string[] }
    | {
        type: 'QUESTION'
        clarificationId: string
        clarification: ClarificationIntent
        wording: string
        rationale: string
        responseSpec: {
          inputMode: 'SINGLE_SELECT' | 'FREE_TEXT'
          allowFreeText: boolean
          allowSkip: boolean
          examples: string[]
          options: Array<{ id: string; label: string }>
        }
      }
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
    groundedClaims?: { claims: Claim[] }
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
      pendingClarification: { clarificationId: string; clarification: ClarificationIntent; askedByMessageId: string } | null
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
  | { type: 'ANSWER_CLARIFICATION'; clarificationId: string; answer: { type: 'OPTION'; optionId: string } | { type: 'TEXT'; text: string } | { type: 'SKIP' } }
  | { type: 'UNDO'; revision: number }
  | { type: 'SET_COMPARISON'; offerRefs: string[] }

export interface ConversationEvent {
  id: string
  seq: number
  eventType: string
  publicPayload: Record<string, unknown>
  createdAt: string
}
