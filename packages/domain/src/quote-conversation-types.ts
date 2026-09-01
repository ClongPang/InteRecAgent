import type { ConversationStatus, OperationSource } from "./conversation-types.js";
import {
  QUOTE_LEAD_CONTRACT_VERSION,
  type QuoteConditionPreference,
  type QuoteLead,
  type QuoteLeadSet,
  type QuoteTarget,
} from "./quote-types.js";

export type ConversationContractVersion = typeof QUOTE_LEAD_CONTRACT_VERSION;

export interface QuoteTargetProposal {
  proposedModel: string;
  brand: string | null;
  productType: string | null;
  requiredQualifiers: string[];
  conditionPreference: QuoteConditionPreference;
}

export interface PendingQuoteTargetConfirmation {
  confirmationId: string;
  proposal: QuoteTargetProposal & { rawText: string };
  reasonCodes: string[];
  askedByMessageId: string;
}

export interface PublishedQuotePriceRange {
  originalPrice: { currency: string; minAmount: string; maxAmount: string };
  cnyEstimate: {
    minAmount: string;
    maxAmount: string;
    fxObservedAt: string;
    fxExpiresAt: string;
  } | null;
}

/** Public, evidence-backed projection without provider internals or availability. */
export interface PublishedQuoteLead {
  quoteLeadRef: string;
  canonicalModel: string;
  representativeTitle: string;
  condition: QuoteLead["condition"];
  merchantLabel: string;
  merchantDomain: string;
  outboundUrl: string;
  priceRanges: PublishedQuotePriceRange[];
  observationCount: number;
  firstObservedAt: string;
  latestObservedAt: string;
}

export interface PublishedQuoteLeadSet {
  contractVersion: typeof QUOTE_LEAD_CONTRACT_VERSION;
  quoteLeadSetRef: string;
  targetRef: string;
  outcome: QuoteLeadSet["outcome"];
  reasonCodes: string[];
  providerStatus: QuoteLeadSet["provider"]["status"];
  providerFailureCode: string | null;
  providerRetryable: boolean | null;
  providerContractVersion: string;
  leads: PublishedQuoteLead[];
  observedAt: string;
}

export interface QuoteConversationState {
  contractVersion: typeof QUOTE_LEAD_CONTRACT_VERSION;
  version: number;
  target: QuoteTarget | null;
  pendingTargetConfirmation: PendingQuoteTargetConfirmation | null;
  leadSet: PublishedQuoteLeadSet | null;
  displayQuoteLeadRefs: string[];
  excludedQuoteLeadRefs: string[];
  comparisonQuoteLeadRefs: string[];
  focusQuoteLeadRef: string | null;
}

export interface QuoteConversationSnapshot {
  revision: number;
  status: ConversationStatus;
  quote: QuoteConversationState;
}

export type QuoteLeadReferent =
  | { kind: "QUOTE_LEAD_REF"; quoteLeadRef: string }
  | { kind: "DISPLAY_RANK"; rank: number }
  | { kind: "FOCUS" }
  | { kind: "COMPARISON" };

interface QuoteOperationBase {
  opId: string;
}

export type QuoteTurnOperation =
  | (QuoteOperationBase & { kind: "SET_QUOTE_TARGET"; source: OperationSource; target: QuoteTargetProposal })
  | (QuoteOperationBase & { kind: "REQUEST_QUOTE_MODEL_CONFIRMATION" })
  | (QuoteOperationBase & { kind: "DECLINE_UNSUPPORTED_QUOTE_TARGET"; reasonCode: "ACCESSORY_OR_PART" | "SERVICE" })
  | (QuoteOperationBase & { kind: "CONFIRM_QUOTE_TARGET"; confirmationId: string })
  | (QuoteOperationBase & { kind: "LOOKUP_QUOTES" })
  | (QuoteOperationBase & { kind: "REFRESH_QUOTES" })
  | (QuoteOperationBase & { kind: "EXCLUDE_QUOTE_LEADS"; referents: QuoteLeadReferent[] })
  | (QuoteOperationBase & { kind: "RESTORE_QUOTE_LEADS"; referents: QuoteLeadReferent[] })
  | (QuoteOperationBase & { kind: "SET_QUOTE_COMPARISON"; referents: QuoteLeadReferent[] })
  | (QuoteOperationBase & { kind: "SET_QUOTE_FOCUS"; referent: QuoteLeadReferent | null })
  | (QuoteOperationBase & { kind: "INSPECT_QUOTE_LEADS"; referents: QuoteLeadReferent[] })
  | (QuoteOperationBase & { kind: "INSPECT_QUOTE_STATUS" });

export interface QuoteTurnPlan {
  userIntentSummary: string;
  ops: QuoteTurnOperation[];
}

export type QuoteAssistantOutcome = "CHAT" | "CLARIFICATION" | "QUOTE_LEADS" | "NO_QUOTE_LEADS" | "DEGRADED";

export interface QuoteAssistantPublication {
  outcome: QuoteAssistantOutcome;
  addressedOpIds: string[];
  disclosureCodes: Array<"MERCHANT_PAGE_CHECK_REQUIRED" | "AFFILIATE_LINK_DISCLOSURE" | "PROVIDER_RESULT_NOT_MARKET_ABSENCE">;
  text: string;
}
