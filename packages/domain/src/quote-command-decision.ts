import { createHash } from "node:crypto";

import { DomainError } from "./errors.js";
import type { QuoteConversationState, QuoteTurnOperation } from "./quote-conversation-types.js";
import { resolveQuoteLeadReferents, validateQuoteConversationState } from "./quote-conversation-state.js";
import type { QuoteEffect, QuoteOperationReceipt } from "./quote-effects.js";
import { resolveQuoteTarget } from "./quote-target.js";

export interface DecideQuoteCommandInput {
  state: QuoteConversationState;
  operation: QuoteTurnOperation;
  currentUserMessages: ReadonlyArray<{ messageId: string; content: string }>;
}

export type QuoteCommandDecision =
  | { decision: "APPLIED"; nextState: QuoteConversationState; receipt: QuoteOperationReceipt; effects: [] }
  | { decision: "EFFECT_REQUIRED"; nextState: QuoteConversationState; receipt: null; effects: [QuoteEffect] };

function confirmationId(rawText: string, model: string): string {
  return `qtc_${createHash("sha256").update(`${rawText}\u0000${model}`).digest("hex").slice(0, 24)}`;
}

function sourceText(operation: Extract<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>, messages: DecideQuoteCommandInput["currentUserMessages"]): string {
  const message = messages.find((item) => item.messageId === operation.source.messageId)?.content;
  if (message === undefined) throw new DomainError("QUOTE_TARGET_SOURCE_NOT_FOUND", operation.source.messageId);
  return operation.source.span ? message.slice(operation.source.span.start, operation.source.span.end) : message;
}

function clearLeadState(state: QuoteConversationState): QuoteConversationState {
  return {
    ...state,
    leadSet: null,
    displayQuoteLeadRefs: [],
    excludedQuoteLeadRefs: [],
    comparisonQuoteLeadRefs: [],
    focusQuoteLeadRef: null,
  };
}

function applied(state: QuoteConversationState, operation: QuoteTurnOperation, publicResult: Record<string, unknown>, status: QuoteOperationReceipt["status"] = "APPLIED"): QuoteCommandDecision {
  return {
    decision: "APPLIED",
    nextState: validateQuoteConversationState(state),
    effects: [],
    receipt: {
      opId: operation.opId,
      kind: operation.kind,
      status,
      providerInvocation: "NONE",
      providerCalled: false,
      publicResult,
    },
  };
}

/** Domain-owned, deterministic command decision. It never invokes a Provider or mutates its input. */
export function decideQuoteCommand(input: DecideQuoteCommandInput): QuoteCommandDecision {
  const state = validateQuoteConversationState(input.state);
  const operation = structuredClone(input.operation);
  if (operation.kind === "SET_QUOTE_TARGET") {
    const rawText = sourceText(operation, input.currentUserMessages);
    const resolution = resolveQuoteTarget({
      rawText,
      ...operation.target,
      ...(operation.identityResolution ? { identityResolution: operation.identityResolution } : {}),
    });
    const cleared = clearLeadState(state);
    if (resolution.status === "RESOLVED") {
      return applied({ ...cleared, target: resolution.target, pendingTargetConfirmation: null }, operation, {
        targetRef: resolution.target.targetRef,
        canonicalModel: resolution.target.canonicalModel,
        confirmationRequired: false,
      });
    }
    return applied({
      ...cleared,
      target: null,
      pendingTargetConfirmation: {
        confirmationId: confirmationId(rawText, operation.target.proposedModel),
        proposal: { rawText, ...structuredClone(operation.target) },
        reasonCodes: [...resolution.reasonCodes],
        askedByMessageId: operation.source.messageId,
        ...(operation.identityResolution ? { identityResolution: structuredClone(operation.identityResolution) } : {}),
      },
    }, operation, { confirmationRequired: true, proposedModel: operation.target.proposedModel }, "BLOCKED");
  }
  if (operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION") {
    // Requesting an exact model means the current ask has no resolvable target, so any prior
    // resolved target and its published observation are superseded. A pending confirmation set
    // earlier in this same plan is preserved (it still describes the gap being clarified).
    return applied({ ...clearLeadState(state), target: null }, operation, { modelRequired: true });
  }
  if (operation.kind === "DECLINE_UNSUPPORTED_QUOTE_TARGET") {
    const retain = operation.targetDisposition === "RETAIN";
    if (retain && (!state.target || state.pendingTargetConfirmation)) {
      throw new DomainError("QUOTE_DECLINE_RETAIN_WITHOUT_TARGET", operation.opId);
    }
    const nextState = retain ? state : { ...clearLeadState(state), target: null };
    return applied(nextState, operation, { declinedReasonCode: operation.reasonCode, targetRetained: retain });
  }
  if (operation.kind === "CONFIRM_QUOTE_TARGET") {
    const pending = state.pendingTargetConfirmation;
    if (!pending || pending.confirmationId !== operation.confirmationId) throw new DomainError("QUOTE_CONFIRMATION_NOT_PENDING", operation.confirmationId);
    const resolution = resolveQuoteTarget({
      ...pending.proposal,
      explicitlyConfirmed: true,
      ...(pending.identityResolution ? { identityResolution: pending.identityResolution } : {}),
    });
    if (resolution.status !== "RESOLVED") throw new DomainError("QUOTE_CONFIRMATION_INVALID", resolution.reasonCodes.join(","));
    return applied({ ...clearLeadState(state), target: resolution.target, pendingTargetConfirmation: null }, operation, {
      targetRef: resolution.target.targetRef,
      canonicalModel: resolution.target.canonicalModel,
    });
  }
  if (operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES") {
    if (!state.target || state.pendingTargetConfirmation) throw new DomainError("QUOTE_TARGET_REQUIRED", operation.opId);
    return {
      decision: "EFFECT_REQUIRED",
      nextState: state,
      receipt: null,
      effects: [{
        effectId: `quote-effect:${operation.opId}`,
        kind: "QUOTE_LOOKUP",
        operationId: operation.opId,
        operationKind: operation.kind,
        target: structuredClone(state.target),
      }],
    };
  }
  if (operation.kind === "INSPECT_QUOTE_STATUS") {
    return applied(state, operation, {
      hasTarget: Boolean(state.target),
      hasPublishedObservation: Boolean(state.leadSet),
      providerStatus: state.leadSet?.providerStatus ?? null,
    });
  }
  const referents = operation.kind === "SET_QUOTE_FOCUS"
    ? operation.referent ? [operation.referent] : []
    : operation.referents;
  const binding = resolveQuoteLeadReferents(state, referents);
  if (referents.length > 0 && binding.status !== "RESOLVED") throw new DomainError("QUOTE_REFERENT_NOT_FOUND", operation.opId);
  const refs = binding.quoteLeadRefs;
  let nextState = state;
  if (operation.kind === "EXCLUDE_QUOTE_LEADS") {
    const excluded = [...new Set([...state.excludedQuoteLeadRefs, ...refs])];
    nextState = {
      ...state,
      excludedQuoteLeadRefs: excluded,
      displayQuoteLeadRefs: state.displayQuoteLeadRefs.filter((ref) => !excluded.includes(ref)),
      comparisonQuoteLeadRefs: state.comparisonQuoteLeadRefs.filter((ref) => !excluded.includes(ref)),
      focusQuoteLeadRef: state.focusQuoteLeadRef && excluded.includes(state.focusQuoteLeadRef) ? null : state.focusQuoteLeadRef,
    };
  } else if (operation.kind === "RESTORE_QUOTE_LEADS") {
    const restored = new Set(refs);
    const excluded = state.excludedQuoteLeadRefs.filter((ref) => !restored.has(ref));
    const leadOrder = state.leadSet?.leads.map((lead) => lead.quoteLeadRef) ?? [];
    nextState = { ...state, excludedQuoteLeadRefs: excluded, displayQuoteLeadRefs: leadOrder.filter((ref) => !excluded.includes(ref)) };
  } else if (operation.kind === "SET_QUOTE_COMPARISON") {
    nextState = { ...state, comparisonQuoteLeadRefs: refs };
  } else if (operation.kind === "SET_QUOTE_FOCUS") {
    nextState = { ...state, focusQuoteLeadRef: refs[0] ?? null };
  }
  return applied(nextState, operation, { quoteLeadRefs: refs });
}
