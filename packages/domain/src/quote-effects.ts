import { DomainError } from "./errors.js";
import type { PublishedQuoteLeadSet, QuoteConversationState, QuoteTurnOperation } from "./quote-conversation-types.js";
import { validateQuoteConversationState } from "./quote-conversation-state.js";
import { validatePublishedQuoteLeadSet } from "./quote-publication.js";
import type { QuoteTarget } from "./quote-types.js";

export interface QuoteOperationReceipt {
  opId: string;
  kind: QuoteTurnOperation["kind"];
  status: "APPLIED" | "BLOCKED";
  providerCalled: boolean;
  publicResult: Record<string, unknown>;
}

export interface QuoteLookupEffect {
  effectId: string;
  kind: "QUOTE_LOOKUP";
  operationId: string;
  operationKind: "LOOKUP_QUOTES" | "REFRESH_QUOTES";
  target: QuoteTarget;
}

export type QuoteEffect = QuoteLookupEffect;

export type QuoteEffectResult =
  | { status: "SUCCEEDED"; leadSet: PublishedQuoteLeadSet }
  | { status: "FAILED"; errorCode: string; retryable: boolean | null };

export type QuoteEffectApplication =
  | { status: "APPLIED"; nextState: QuoteConversationState; receipt: QuoteOperationReceipt }
  | { status: "FAILED"; nextState: QuoteConversationState; errorCode: string; retryable: boolean | null };

/** Purely applies a runtime result. A failed effect always preserves the complete pre-effect state. */
export function applyQuoteEffectResult(
  stateInput: QuoteConversationState,
  effect: QuoteEffect,
  result: QuoteEffectResult,
): QuoteEffectApplication {
  const state = validateQuoteConversationState(stateInput);
  if (!state.target || state.pendingTargetConfirmation) throw new DomainError("QUOTE_TARGET_REQUIRED", effect.operationId);
  if (state.target.targetRef !== effect.target.targetRef) throw new DomainError("QUOTE_EFFECT_TARGET_MISMATCH", effect.effectId);
  if (result.status === "FAILED") {
    return {
      status: "FAILED",
      nextState: state,
      errorCode: result.errorCode.normalize("NFKC").trim().slice(0, 160) || "QUOTE_EFFECT_FAILED",
      retryable: result.retryable,
    };
  }
  const leadSet = validatePublishedQuoteLeadSet(result.leadSet);
  if (leadSet.targetRef !== state.target.targetRef) throw new DomainError("QUOTE_LOOKUP_TARGET_MISMATCH", leadSet.targetRef);
  const returnedRefs = new Set(leadSet.leads.map((lead) => lead.quoteLeadRef));
  const refresh = effect.operationKind === "REFRESH_QUOTES";
  const excludedQuoteLeadRefs = refresh
    ? state.excludedQuoteLeadRefs.filter((ref) => returnedRefs.has(ref))
    : [];
  const displayQuoteLeadRefs = leadSet.leads
    .map((lead) => lead.quoteLeadRef)
    .filter((ref) => !excludedQuoteLeadRefs.includes(ref));
  const nextState = validateQuoteConversationState({
    ...state,
    leadSet,
    displayQuoteLeadRefs,
    excludedQuoteLeadRefs,
    comparisonQuoteLeadRefs: refresh
      ? state.comparisonQuoteLeadRefs.filter((ref) => displayQuoteLeadRefs.includes(ref))
      : [],
    focusQuoteLeadRef: refresh && state.focusQuoteLeadRef && displayQuoteLeadRefs.includes(state.focusQuoteLeadRef)
      ? state.focusQuoteLeadRef
      : null,
  });
  return {
    status: "APPLIED",
    nextState,
    receipt: {
      opId: effect.operationId,
      kind: effect.operationKind,
      status: "APPLIED",
      providerCalled: true,
      publicResult: {
        outcome: leadSet.outcome,
        providerStatus: leadSet.providerStatus,
        quoteLeadCount: leadSet.leads.length,
        observedAt: leadSet.observedAt,
      },
    },
  };
}
