import { DomainError } from "./errors.js";
import type { QuoteConversationState, QuoteLeadReferent } from "./quote-conversation-types.js";
import { validatePublishedQuoteLeadSet } from "./quote-publication.js";
import { QUOTE_LEAD_CONTRACT_VERSION } from "./quote-types.js";
import { assertNoForbiddenPublicKey, uniqueRefs } from "./quote-validation.js";

export function emptyQuoteConversationState(version = 0): QuoteConversationState {
  if (!Number.isSafeInteger(version) || version < 0) throw new DomainError("INVALID_QUOTE_STATE_VERSION", String(version));
  return {
    contractVersion: QUOTE_LEAD_CONTRACT_VERSION,
    version,
    target: null,
    pendingTargetConfirmation: null,
    leadSet: null,
    displayQuoteLeadRefs: [],
    excludedQuoteLeadRefs: [],
    comparisonQuoteLeadRefs: [],
    focusQuoteLeadRef: null,
  };
}

export function validateQuoteConversationState(input: QuoteConversationState): QuoteConversationState {
  const value = structuredClone(input);
  assertNoForbiddenPublicKey(value);
  if (value.contractVersion !== QUOTE_LEAD_CONTRACT_VERSION) throw new DomainError("QUOTE_CONTRACT_VERSION_MISMATCH", value.contractVersion);
  if (!Number.isSafeInteger(value.version) || value.version < 0) throw new DomainError("INVALID_QUOTE_STATE_VERSION", String(value.version));
  if (value.target && value.target.itemRole !== "PRIMARY_PRODUCT") throw new DomainError("QUOTE_TARGET_ROLE_MISMATCH", value.target.itemRole);
  if (value.pendingTargetConfirmation && value.target) throw new DomainError("QUOTE_TARGET_CONFIRMATION_STATE_CONFLICT", value.pendingTargetConfirmation.confirmationId);
  if (value.leadSet) {
    value.leadSet = validatePublishedQuoteLeadSet(value.leadSet);
    if (!value.target || value.leadSet.targetRef !== value.target.targetRef) throw new DomainError("QUOTE_LEAD_SET_TARGET_MISMATCH", value.leadSet.targetRef);
  }
  const all = new Set(value.leadSet?.leads.map((lead) => lead.quoteLeadRef) ?? []);
  value.displayQuoteLeadRefs = uniqueRefs(value.displayQuoteLeadRefs, "DUPLICATE_DISPLAY_QUOTE_LEAD_REF");
  value.excludedQuoteLeadRefs = uniqueRefs(value.excludedQuoteLeadRefs, "DUPLICATE_EXCLUDED_QUOTE_LEAD_REF");
  value.comparisonQuoteLeadRefs = uniqueRefs(value.comparisonQuoteLeadRefs, "DUPLICATE_COMPARISON_QUOTE_LEAD_REF");
  for (const ref of [...value.displayQuoteLeadRefs, ...value.excludedQuoteLeadRefs, ...value.comparisonQuoteLeadRefs]) {
    if (!all.has(ref)) throw new DomainError("QUOTE_LEAD_REF_OUTSIDE_SET", ref);
  }
  if (value.displayQuoteLeadRefs.some((ref) => value.excludedQuoteLeadRefs.includes(ref))) throw new DomainError("QUOTE_DISPLAY_EXCLUSION_OVERLAP", value.leadSet?.quoteLeadSetRef ?? "none");
  if (value.comparisonQuoteLeadRefs.some((ref) => !value.displayQuoteLeadRefs.includes(ref))) throw new DomainError("QUOTE_COMPARISON_NOT_DISPLAYED", value.leadSet?.quoteLeadSetRef ?? "none");
  if (value.focusQuoteLeadRef !== null && !value.displayQuoteLeadRefs.includes(value.focusQuoteLeadRef)) throw new DomainError("QUOTE_FOCUS_NOT_DISPLAYED", value.focusQuoteLeadRef);
  return value;
}

export function resolveQuoteLeadReferents(
  state: QuoteConversationState,
  referents: readonly QuoteLeadReferent[],
): { status: "RESOLVED"; quoteLeadRefs: string[] } | { status: "NOT_FOUND" | "AMBIGUOUS"; quoteLeadRefs: string[] } {
  const values: string[] = [];
  for (const referent of referents) {
    if (referent.kind === "QUOTE_LEAD_REF") values.push(referent.quoteLeadRef);
    else if (referent.kind === "DISPLAY_RANK") {
      const ref = state.displayQuoteLeadRefs[referent.rank - 1];
      if (!ref) return { status: "NOT_FOUND", quoteLeadRefs: [] };
      values.push(ref);
    } else if (referent.kind === "FOCUS") {
      if (!state.focusQuoteLeadRef) return { status: "NOT_FOUND", quoteLeadRefs: [] };
      values.push(state.focusQuoteLeadRef);
    } else {
      if (state.comparisonQuoteLeadRefs.length === 0) return { status: "NOT_FOUND", quoteLeadRefs: [] };
      values.push(...state.comparisonQuoteLeadRefs);
    }
  }
  const quoteLeadRefs = [...new Set(values)];
  if (quoteLeadRefs.some((ref) => !state.leadSet?.leads.some((lead) => lead.quoteLeadRef === ref))) return { status: "NOT_FOUND", quoteLeadRefs: [] };
  return { status: "RESOLVED", quoteLeadRefs };
}
