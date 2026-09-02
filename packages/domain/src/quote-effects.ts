import { DomainError } from "./errors.js";
import type { PublishedQuoteLeadSet, QuoteConversationState, QuoteTurnOperation } from "./quote-conversation-types.js";
import { validateQuoteConversationState } from "./quote-conversation-state.js";
import { validatePublishedQuoteLeadSet } from "./quote-publication.js";
import type { QuoteTarget } from "./quote-types.js";

/**
 * How this receipt relates to the physical quote provider.
 * NONE: no lookup effect. LIVE: this attempt issued HTTP. ATTEMPT_REPLAY: reused
 * a lead set already persisted for the same attempt (no second HTTP).
 */
export type QuoteProviderInvocation = "NONE" | "LIVE" | "ATTEMPT_REPLAY";

export function liveProviderCalled(invocation: QuoteProviderInvocation): boolean {
  return invocation === "LIVE";
}

export function appliedProviderObservation(invocation: QuoteProviderInvocation): boolean {
  return invocation === "LIVE" || invocation === "ATTEMPT_REPLAY";
}

export interface QuoteOperationReceipt {
  opId: string;
  kind: QuoteTurnOperation["kind"];
  status: "APPLIED" | "BLOCKED";
  providerInvocation: QuoteProviderInvocation;
  /** Derived: true only for LIVE. Eval/budget still count HTTP, not effect application. */
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
  | { status: "SUCCEEDED"; leadSet: PublishedQuoteLeadSet; providerInvocation: Exclude<QuoteProviderInvocation, "NONE"> }
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
      providerInvocation: result.providerInvocation,
      providerCalled: liveProviderCalled(result.providerInvocation),
      publicResult: {
        outcome: leadSet.outcome,
        providerStatus: leadSet.providerStatus,
        providerFailureCode: leadSet.providerFailureCode,
        providerInvocation: result.providerInvocation,
        quoteLeadCount: leadSet.leads.length,
        observedAt: leadSet.observedAt,
      },
    },
  };
}
