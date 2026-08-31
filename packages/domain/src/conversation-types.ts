import type { EvidenceRef, ItemRole, MarketEvidenceLevel, Money, ProductCondition, StockStatus } from "./types.js";
import type { CandidateRankingMetadata } from "./candidate-ranking-types.js";
import type { CandidateAdmissionDecision, QueryProductRelevanceAssessment } from "./query-product-relevance-types.js";
import type { ClarificationUncertainty } from "./uncertainty.js";

export type ConversationStatus = "OPEN" | "CLOSED" | "BLOCKED";
export type TurnExecutionStatus =
  | "ACCEPTED"
  | "CLAIMED"
  | "RUNNING"
  | "COMMITTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "SUPERSEDED"
  | "DEAD_LETTER";

export type AssistantOutcome = "CHAT" | "CLARIFICATION" | "SEARCH_RESULTS" | "RECOMMENDATION" | "NO_MATCH" | "DEGRADED";
export type ConversationRoute = "talk" | "clarify" | "refilter" | "sort" | "search";

export interface OperationSource {
  messageId: string;
  span?: { start: number; end: number };
}

export interface ShoppingTarget {
  categoryId: string;
  /** Exact user-facing product phrase. Optional while persisted V1 goals are migrated on read. */
  targetText?: string;
  canonicalModel: string | null;
  itemRole: Exclude<ItemRole, "UNKNOWN">;
  condition: Exclude<ProductCondition, "UNKNOWN"> | "ANY";
}

export type ConstraintValue = string | number | boolean | string[];

export interface GoalConstraint {
  key: string;
  operator: "EQ" | "IN" | "LTE" | "GTE" | "CONTAINS";
  value: ConstraintValue;
  source: OperationSource;
}

export interface GoalPreference {
  key: string;
  value: ConstraintValue;
  weight: number;
  source: OperationSource;
}

export interface GoalGap {
  slotId: string;
  reasonCodes: string[];
  askedByMessageId: string | null;
}

export interface EntityRef {
  kind: "OFFER" | "MODEL" | "BRAND" | "CATEGORY";
  value: string;
}

export interface ShoppingGoal {
  target: ShoppingTarget | null;
  budget: Money | null;
  retrievalMarkets: string[];
  deliveryDestination: string | null;
  stockPreference: "ANY" | "KNOWN_IN_STOCK";
  hardConstraints: GoalConstraint[];
  preferences: GoalPreference[];
  exclusions: EntityRef[];
  unresolved: GoalGap[];
}

interface GoalOperationBase {
  opId: string;
  source: OperationSource;
}

export type GoalOperation =
  | (GoalOperationBase & { kind: "GOAL_SET_TARGET"; target: ShoppingTarget })
  | (GoalOperationBase & { kind: "GOAL_CLEAR_TARGET" })
  | (GoalOperationBase & { kind: "GOAL_SET_BUDGET"; budget: Money })
  | (GoalOperationBase & { kind: "GOAL_CLEAR_BUDGET" })
  | (GoalOperationBase & { kind: "GOAL_SET_RETRIEVAL_MARKETS"; markets: string[] })
  | (GoalOperationBase & { kind: "GOAL_SET_DELIVERY_DESTINATION"; destination: string | null })
  | (GoalOperationBase & { kind: "GOAL_SET_STOCK_PREFERENCE"; preference: "ANY" | "KNOWN_IN_STOCK" })
  | (GoalOperationBase & { kind: "GOAL_UPSERT_CONSTRAINT"; constraint: Omit<GoalConstraint, "source"> })
  | (GoalOperationBase & { kind: "GOAL_REMOVE_CONSTRAINT"; key: string })
  | (GoalOperationBase & { kind: "GOAL_UPSERT_PREFERENCE"; preference: Omit<GoalPreference, "source"> })
  | (GoalOperationBase & { kind: "GOAL_REMOVE_PREFERENCE"; key: string })
  | (GoalOperationBase & { kind: "GOAL_EXCLUDE_ENTITY"; entity: EntityRef })
  | (GoalOperationBase & { kind: "GOAL_RESTORE_ENTITY"; entity: EntityRef })
  | (GoalOperationBase & { kind: "GOAL_ADD_GAP"; gap: Omit<GoalGap, "askedByMessageId"> })
  | (GoalOperationBase & { kind: "GOAL_RESOLVE_GAP"; slotId: string });

export interface GoalRevision {
  version: number;
  parentVersion: number | null;
  goal: ShoppingGoal;
  operations: GoalOperation[];
  committedByTurnId: string;
}

export interface CandidateView {
  offerRef: string;
  title: string;
  canonicalModel: string | null;
  categoryId: string;
  itemRole: ItemRole;
  condition: ProductCondition;
  retrievalMarket: string;
  merchant: string;
  cnyAmount: string;
  stock: StockStatus;
  claimIds: string[];
  marketEvidenceLevel?: MarketEvidenceLevel;
  rankingReasonCodes?: string[];
  ranking?: CandidateRankingMetadata;
  queryProductRelevance?: QueryProductRelevanceAssessment;
  candidateAdmission?: CandidateAdmissionDecision;
}

export interface WorkingSet {
  version: number;
  boundGoalVersion: number;
  pool: CandidateView[];
  displayOfferRefs: string[];
  mentionedOfferRefs: string[];
  comparisonOfferRefs: string[];
  rejectedOfferRefs: string[];
  focusOfferRef: string | null;
}

export type CandidateReferent =
  | { kind: "OFFER_REF"; offerRef: string }
  | { kind: "DISPLAY_RANK"; rank: number }
  | { kind: "FOCUS" }
  | { kind: "COMPARISON" }
  | { kind: "TEXT"; text: string };

export type CandidateBinding =
  | { status: "RESOLVED"; offerRefs: string[] }
  | { status: "AMBIGUOUS"; offerRefs: string[] }
  | { status: "NOT_FOUND"; offerRefs: [] };

export type InspectableField = "PRICE" | "MERCHANT" | "MARKET" | "STOCK" | "MODEL" | "CONDITION" | "RANKING_REASON" | "WARRANTY";

import type { ClarificationIntent, ClarificationResponseSpec } from "./clarification.js";

interface TurnOperationBase {
  opId: string;
}

export type TurnAction =
  | (TurnOperationBase & { kind: "REJECT_OFFERS"; referents: CandidateReferent[]; reasonCode: string })
  | (TurnOperationBase & { kind: "RESTORE_OFFERS"; referents: CandidateReferent[] })
  | (TurnOperationBase & { kind: "SET_COMPARISON"; referents: CandidateReferent[] })
  | (TurnOperationBase & { kind: "SET_FOCUS"; referent: CandidateReferent | null })
  | (TurnOperationBase & { kind: "INSPECT_WORKING_SET"; referents: CandidateReferent[]; fields: InspectableField[] })
  | (TurnOperationBase & { kind: "INSPECT_SEARCH_COVERAGE" })
  | (TurnOperationBase & { kind: "REFILTER_WORKING_SET" })
  | (TurnOperationBase & { kind: "SORT_WORKING_SET_BY_PRICE"; preferenceKey: string })
  | (TurnOperationBase & { kind: "SEARCH_OFFERS"; reasonCode: string; queryVariant?: string; marketScope?: string[]; assumptionDisclosureCodes?: string[] })
  | (TurnOperationBase & {
    kind: "REQUEST_CLARIFICATION";
    clarification: ClarificationIntent;
    uncertainty: ClarificationUncertainty;
    reasonCode: string;
  })
  | (TurnOperationBase & { kind: "RESOLVE_CLARIFICATION"; clarificationId: string; clarification: ClarificationIntent; outcome: "ANSWERED" | "SKIPPED" })
  | (TurnOperationBase & { kind: "UNDO_REVISION"; revision: number });

export type TurnOperation = GoalOperation | TurnAction;

export interface PendingOperation {
  operation: TurnOperation;
  conditionCode: string;
}

export interface TurnPlan {
  ops: TurnOperation[];
  leftover: PendingOperation[];
  userIntentSummary: string;
}

export interface DialogueState {
  pendingClarification: { clarificationId: string; clarification: ClarificationIntent; askedByMessageId: string } | null;
  clarificationHistory: Array<{
    clarification: ClarificationIntent;
    outcome: "ANSWERED" | "SKIPPED" | "ASSUMED";
    recordedAtGoalVersion: number | null;
  }>;
  pendingOps: PendingOperation[];
  focusOfferRef: string | null;
  comparisonOfferRefs: string[];
  lastAssistantMessageId: string | null;
}

export type DialogueOperation =
  | { kind: "DIALOGUE_REQUEST_CLARIFICATION"; clarificationId: string; clarification: ClarificationIntent; askedByMessageId: string }
  | { kind: "DIALOGUE_CLEAR_CLARIFICATION"; clarification: ClarificationIntent }
  | { kind: "DIALOGUE_RECORD_CLARIFICATION_OUTCOME"; clarification: ClarificationIntent; outcome: "ANSWERED" | "SKIPPED" | "ASSUMED"; goalVersion: number | null }
  | { kind: "DIALOGUE_SET_PENDING_OPERATIONS"; pendingOps: PendingOperation[] }
  | { kind: "DIALOGUE_SYNC_WORKING_SET"; focusOfferRef: string | null; comparisonOfferRefs: string[] }
  | { kind: "DIALOGUE_RECORD_ASSISTANT_MESSAGE"; messageId: string };

export type ClaimKind = "PRICE" | "FX" | "MERCHANT" | "MARKET" | "STOCK" | "MODEL" | "CONDITION" | "RANKING_REASON" | "SEARCH_STATUS";

export interface ClaimEvidenceRef extends EvidenceRef {
  sourceFactRef: string;
  canonicalValue: unknown;
  providerSchemaVersion: string;
  policyVersion: string;
  derivation: "OBSERVED" | "DERIVED";
  fxSnapshotId?: string;
}

export interface GroundedClaim {
  claimId: string;
  kind: ClaimKind;
  canonicalValue: unknown;
  renderedText: string;
  evidenceRefs: ClaimEvidenceRef[];
  offerRefs: string[];
}

export interface GroundedClaimSet {
  claims: GroundedClaim[];
}

export type AssistantBlock =
  | { type: "TRANSITION"; text: string }
  | { type: "CLAIM"; claimId: string }
  | { type: "COMPARISON"; claimIds: string[] }
  | { type: "QUESTION"; clarificationId: string; clarification: ClarificationIntent; wording: string; rationale: string; responseSpec: ClarificationResponseSpec }
  | { type: "DISCLOSURE"; disclosureCode: string };

export interface TypedNextMove {
  id: string;
  label: string;
  operation: TurnOperation;
}

export interface AssistantEnvelope {
  outcome: AssistantOutcome;
  addressedOpIds: string[];
  blocks: AssistantBlock[];
  nextMoves: TypedNextMove[];
}

export interface ConversationState {
  revision: number;
  status: ConversationStatus;
  goalRevision: GoalRevision | null;
  dialogue: DialogueState;
  workingSet: WorkingSet | null;
}
