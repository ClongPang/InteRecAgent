import { DomainError } from "./errors.js";
import { resolveQuoteLeadReferents } from "./quote-conversation-state.js";
import type { QuoteConversationState, QuoteTurnOperation, QuoteTurnPlan } from "./quote-conversation-types.js";
import { resolveQuoteTarget } from "./quote-target.js";

export const QUOTE_PLAN_POLICY_VERSION = "quote-plan-policy-v2" as const;
export const MAX_QUOTE_TURN_OPERATIONS = 8;

export interface QuotePlanPolicyViolation {
  code: string;
  operationId: string | null;
  path: string;
  observed: unknown;
  admissibleAlternatives: string[];
}

export type QuotePlanReview =
  | { decision: "APPROVED"; policyVersion: typeof QUOTE_PLAN_POLICY_VERSION; route: "talk" | "clarify" | "quote_followup" | "quote_lookup"; providerCallsAllowed: 0 | 1 }
  | { decision: "REPAIR_REQUIRED"; policyVersion: typeof QUOTE_PLAN_POLICY_VERSION; violations: QuotePlanPolicyViolation[] };

export interface ReviewQuoteTurnPlanInput {
  plan: QuoteTurnPlan;
  state: QuoteConversationState;
  currentUserMessages: ReadonlyArray<{ messageId: string; content: string }>;
}

const REFRESH_PATTERN = /(?:\brefresh\b|\bsearch\s+again\b|\bcheck\s+again\b|重新(?:查|搜|查询)|刷新|再查(?:一次)?|更新报价)/iu;
const CONFIRM_PATTERN = /(?:\b(?:yes|confirm|correct|right)\b|确认|没错|对的|就是|是这个)/iu;
const ACCESSORY_OR_SERVICE_PATTERN = /(?:\b(?:replacement|repair|service|spare|accessor(?:y|ies)|ear\s*pads?|case|cable|charger)\b|维修|修理|服务|替换|更换|配件|耳罩|耳垫|保护壳|充电器|数据线)/iu;

function violation(code: string, operation: QuoteTurnOperation | null, observed: unknown, alternatives: string[]): QuotePlanReview {
  return {
    decision: "REPAIR_REQUIRED",
    policyVersion: QUOTE_PLAN_POLICY_VERSION,
    violations: [{
      code,
      operationId: operation?.opId ?? null,
      path: operation ? `ops.${operation.opId}` : "ops",
      observed,
      admissibleAlternatives: alternatives,
    }],
  };
}

function conditionGrounded(rawText: string, operation: Extract<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>): boolean {
  const preference = operation.target.conditionPreference;
  if (preference === "ANY") return true;
  if (preference === "NEW" || preference === "NEW_OR_UNSPECIFIED") return /(?:\bnew\b|brand[- ]?new|全新|新品|新机)/iu.test(rawText);
  if (preference === "REFURBISHED") return /(?:\brefurb(?:ished)?\b|翻新)/iu.test(rawText);
  return /(?:\bused\b|pre[- ]?owned|二手)/iu.test(rawText);
}

function routeFor(plan: QuoteTurnPlan): QuotePlanReview & { decision: "APPROVED" } {
  const provider = plan.ops.some((operation) => operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES");
  const clarify = plan.ops.some((operation) => operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION");
  const followup = plan.ops.some((operation) => [
    "EXCLUDE_QUOTE_LEADS", "RESTORE_QUOTE_LEADS", "SET_QUOTE_COMPARISON", "SET_QUOTE_FOCUS", "INSPECT_QUOTE_LEADS",
  ].includes(operation.kind));
  return {
    decision: "APPROVED",
    policyVersion: QUOTE_PLAN_POLICY_VERSION,
    route: provider ? "quote_lookup" : clarify ? "clarify" : followup ? "quote_followup" : "talk",
    providerCallsAllowed: provider ? 1 : 0,
  };
}

export function reviewQuoteTurnPlan(input: ReviewQuoteTurnPlanInput): QuotePlanReview {
  const summary = input.plan.userIntentSummary.normalize("NFKC").trim();
  if (!summary) return violation("QUOTE_INTENT_SUMMARY_REQUIRED", null, input.plan.userIntentSummary, ["Provide a short intent summary."]);
  if (input.plan.ops.length < 1 || input.plan.ops.length > MAX_QUOTE_TURN_OPERATIONS) {
    return violation("QUOTE_OPERATION_BUDGET_EXCEEDED", null, input.plan.ops.length, [`Use 1-${MAX_QUOTE_TURN_OPERATIONS} operations.`]);
  }
  const ids = input.plan.ops.map((operation) => operation.opId.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return violation("DUPLICATE_QUOTE_OPERATION_ID", null, ids, ["Use a unique non-empty opId for every operation."]);
  const providerOps = input.plan.ops.filter((operation) => operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES");
  if (providerOps.length > 1) return violation("MULTIPLE_QUOTE_PROVIDER_OPERATIONS", providerOps[1]!, providerOps.map((operation) => operation.kind), ["Keep exactly one lookup or refresh operation."]);

  let hasTarget = Boolean(input.state.target);
  let targetChanged = false;
  let pendingConfirmation = input.state.pendingTargetConfirmation;
  for (const [index, operation] of input.plan.ops.entries()) {
    if (operation.kind === "SET_QUOTE_TARGET") {
      const source = operation.source;
      const rawText = input.currentUserMessages.find((message) => message.messageId === source.messageId)?.content;
      if (rawText === undefined) return violation("QUOTE_TARGET_SOURCE_NOT_FOUND", operation, source, ["Cite one current user message ordinal."]);
      if (source.span && (!Number.isSafeInteger(source.span.start) || !Number.isSafeInteger(source.span.end)
        || source.span.start < 0 || source.span.end <= source.span.start || source.span.end > rawText.length)) {
        return violation("QUOTE_TARGET_SOURCE_SPAN_INVALID", operation, source.span, ["Remove the span or cite an exact in-bounds substring."]);
      }
      const groundedText = source.span ? rawText.slice(source.span.start, source.span.end) : rawText;
      if (ACCESSORY_OR_SERVICE_PATTERN.test(groundedText)) {
        return violation("QUOTE_PRIMARY_PRODUCT_REQUIRED", operation, groundedText, ["Explain that accessory, replacement-part and service searches are outside this quote service."]);
      }
      if (!conditionGrounded(groundedText, operation)) {
        return violation("QUOTE_CONDITION_NOT_GROUNDED", operation, operation.target.conditionPreference, ["Use ANY unless the current user text explicitly states the condition."]);
      }
      const resolution = resolveQuoteTarget({
        rawText: groundedText,
        ...operation.target,
        ...(operation.identityResolution ? { identityResolution: operation.identityResolution } : {}),
      });
      const clarificationCodes = new Set([
        "MODEL_NOT_LEXICALLY_GROUNDED",
        "MODEL_CANONICAL_ALIAS_REQUIRES_CONFIRMATION",
        "ALIAS_AMBIGUOUS",
      ]);
      if (resolution.status === "NEEDS_CONFIRMATION" && !resolution.reasonCodes.every((code) => clarificationCodes.has(code))) {
        return violation("QUOTE_TARGET_FIELDS_NOT_GROUNDED", operation, resolution.reasonCodes, ["Keep brand, product type and qualifiers only when they occur in the cited user text.", "Request the exact model if it cannot be resolved."]);
      }
      hasTarget = resolution.status === "RESOLVED";
      pendingConfirmation = resolution.status === "NEEDS_CONFIRMATION" ? {
        confirmationId: "pending-review",
        proposal: { rawText: groundedText, ...operation.target },
        reasonCodes: resolution.reasonCodes,
        askedByMessageId: operation.source.messageId,
        ...(operation.identityResolution ? { identityResolution: structuredClone(operation.identityResolution) } : {}),
      } : null;
      targetChanged = true;
      continue;
    }
    if (operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION") {
      if (providerOps.length > 0) return violation("LOOKUP_BEFORE_MODEL_CONFIRMATION", providerOps[0]!, providerOps[0]!.kind, ["Remove the provider operation until the exact model is supplied or confirmed."]);
      continue;
    }
    if (operation.kind === "DECLINE_UNSUPPORTED_QUOTE_TARGET") {
      if (providerOps.length > 0) return violation("UNSUPPORTED_TARGET_PROVIDER_CALL", providerOps[0]!, operation.reasonCode, ["Remove every provider operation for an unsupported target."]);
      if (operation.targetDisposition === "RETAIN" && (!hasTarget || pendingConfirmation)) {
        return violation("QUOTE_DECLINE_RETAIN_WITHOUT_TARGET", operation, operation.targetDisposition, ["Only RETAIN when a resolved target is currently active.", "Omit targetDisposition or use SUPERSEDE otherwise."]);
      }
      continue;
    }
    if (operation.kind === "CONFIRM_QUOTE_TARGET") {
      if (!pendingConfirmation || pendingConfirmation.confirmationId !== operation.confirmationId) {
        return violation("QUOTE_CONFIRMATION_NOT_PENDING", operation, operation.confirmationId, ["Use the exact pending confirmationId or request a new target."]);
      }
      if (!input.currentUserMessages.some(({ content }) => CONFIRM_PATTERN.test(content) || content.toLocaleUpperCase("en-US").includes(pendingConfirmation!.proposal.proposedModel.toLocaleUpperCase("en-US")))) {
        return violation("QUOTE_CONFIRMATION_NOT_EXPLICIT", operation, input.currentUserMessages, ["Wait for an explicit confirmation or exact model repetition."]);
      }
      hasTarget = true;
      pendingConfirmation = null;
      targetChanged = true;
      continue;
    }
    if (operation.kind === "LOOKUP_QUOTES") {
      if (pendingConfirmation) return violation("LOOKUP_BEFORE_MODEL_CONFIRMATION", operation, pendingConfirmation.reasonCodes, ["Wait for explicit model confirmation."]);
      if (!hasTarget) return violation("QUOTE_TARGET_REQUIRED", operation, null, ["Set an exact target before lookup.", "Request the exact model instead."]);
      if (input.state.leadSet && !targetChanged) return violation("REFRESH_OPERATION_REQUIRED", operation, input.state.leadSet.quoteLeadSetRef, ["Use REFRESH_QUOTES only after the user explicitly asks to refresh."]);
      if (index === 0 && !input.state.target) return violation("QUOTE_TARGET_REQUIRED", operation, null, ["Place SET_QUOTE_TARGET before LOOKUP_QUOTES."]);
      continue;
    }
    if (operation.kind === "REFRESH_QUOTES") {
      if (!hasTarget || !input.state.target) return violation("QUOTE_TARGET_REQUIRED", operation, null, ["Set and confirm an exact target before refreshing."]);
      if (!input.currentUserMessages.some(({ content }) => REFRESH_PATTERN.test(content))) {
        return violation("QUOTE_REFRESH_NOT_EXPLICIT", operation, input.currentUserMessages, ["Remove REFRESH_QUOTES and answer from the current published observation."]);
      }
      continue;
    }
    if (["EXCLUDE_QUOTE_LEADS", "RESTORE_QUOTE_LEADS", "SET_QUOTE_COMPARISON", "INSPECT_QUOTE_LEADS"].includes(operation.kind)) {
      const referents = (operation as Extract<QuoteTurnOperation, { referents: unknown }>).referents;
      const binding = resolveQuoteLeadReferents(input.state, referents);
      if (binding.status !== "RESOLVED") return violation("QUOTE_REFERENT_NOT_FOUND", operation, referents, ["Use a current displayed rank or quoteLeadRef."]);
      if (operation.kind === "SET_QUOTE_COMPARISON" && (binding.quoteLeadRefs.length < 2 || binding.quoteLeadRefs.length > 4)) {
        return violation("QUOTE_COMPARISON_SIZE_INVALID", operation, binding.quoteLeadRefs, ["Compare 2-4 current quote leads."]);
      }
    }
    if (operation.kind === "SET_QUOTE_FOCUS" && operation.referent) {
      const binding = resolveQuoteLeadReferents(input.state, [operation.referent]);
      if (binding.status !== "RESOLVED" || binding.quoteLeadRefs.length !== 1) return violation("QUOTE_FOCUS_AMBIGUOUS", operation, operation.referent, ["Focus exactly one current quote lead."]);
    }
  }
  if (targetChanged && hasTarget && !pendingConfirmation && providerOps.length === 0) {
    return violation("QUOTE_LOOKUP_REQUIRED_AFTER_TARGET_CHANGE", null, input.plan.ops.map((operation) => operation.kind), ["Add one LOOKUP_QUOTES after the exact target is established."]);
  }
  return routeFor({ ...input.plan, userIntentSummary: summary });
}

/** Converts the model-facing ordinal into immutable message provenance. */
export function bindQuoteTargetSource(
  source: { sourceMessageOrdinal: number; sourceSpan?: { start: number; end: number } },
  messageIds: readonly string[],
): { messageId: string; span?: { start: number; end: number } } {
  const messageId = messageIds[source.sourceMessageOrdinal];
  if (!messageId) throw new DomainError("QUOTE_TARGET_SOURCE_NOT_FOUND", String(source.sourceMessageOrdinal));
  return {
    messageId,
    ...(source.sourceSpan ? { span: structuredClone(source.sourceSpan) } : {}),
  };
}
