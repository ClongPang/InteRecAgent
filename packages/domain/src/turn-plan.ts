import { DomainError } from "./errors.js";
import { normalizeClarificationIntent } from "./clarification.js";
import type { ConversationRoute, GoalOperation, TurnOperation, TurnPlan } from "./conversation-types.js";

export const MAX_TURN_OPERATIONS = 12;

function isGoalOperation(operation: TurnOperation): operation is GoalOperation {
  return operation.kind.startsWith("GOAL_");
}

export function validateTurnPlan(plan: TurnPlan): TurnPlan {
  const summary = plan.userIntentSummary.trim();
  if (!summary) throw new DomainError("TURN_INTENT_SUMMARY_REQUIRED", "Turn intent summary is required");
  if (plan.ops.length < 1 || plan.ops.length > MAX_TURN_OPERATIONS) throw new DomainError("TURN_OPERATION_BUDGET_EXCEEDED", String(plan.ops.length));
  if (plan.leftover.length > 4) throw new DomainError("PENDING_OPERATION_BUDGET_EXCEEDED", String(plan.leftover.length));

  const ids = [...plan.ops.map((item) => item.opId), ...plan.leftover.map((item) => item.operation.opId)];
  if (new Set(ids).size !== ids.length) throw new DomainError("DUPLICATE_OPERATION_ID", ids.join(","));
  if (plan.ops.filter((item) => item.kind === "SEARCH_OFFERS").length > 1) throw new DomainError("MULTIPLE_SEARCH_OPERATIONS", "At most one search action is allowed");

  const hasUndo = plan.ops.some((item) => item.kind === "UNDO_REVISION");
  if (hasUndo && plan.ops.some(isGoalOperation)) throw new DomainError("UNDO_AND_GOAL_PATCH_CONFLICT", "Undo and goal mutation cannot share a turn");

  const normalizeOperation = (operation: TurnOperation): TurnOperation => {
    if (operation.kind === "SEARCH_OFFERS") {
      const marketScope = operation.marketScope ? [...new Set(operation.marketScope)] : undefined;
      const assumptionDisclosureCodes = operation.assumptionDisclosureCodes
        ? [...new Set(operation.assumptionDisclosureCodes)]
        : undefined;
      if (marketScope && (marketScope.length === 0 || marketScope.some((market) => !["US", "SG"].includes(market)))) {
        throw new DomainError("INVALID_SEARCH_MARKET_SCOPE", "Exploratory search scope must contain only supported markets");
      }
      if (assumptionDisclosureCodes && (assumptionDisclosureCodes.length === 0 || assumptionDisclosureCodes.some((code) => ![
        "PURCHASE_MARKET_SCOPE_ASSUMED",
        "PRODUCT_CONDITION_NOT_RESTRICTED",
      ].includes(code)))) {
        throw new DomainError("INVALID_SEARCH_ASSUMPTION_DISCLOSURE", "Search assumption disclosure is not registered");
      }
      if (assumptionDisclosureCodes?.includes("PURCHASE_MARKET_SCOPE_ASSUMED") && !marketScope) {
        throw new DomainError("SEARCH_MARKET_SCOPE_DISCLOSURE_MISMATCH", "Market-scope disclosure requires an explicit exploratory scope");
      }
      return {
        ...structuredClone(operation),
        ...(marketScope ? { marketScope } : {}),
        ...(assumptionDisclosureCodes ? { assumptionDisclosureCodes } : {}),
      };
    }
    if (operation.kind !== "REQUEST_CLARIFICATION") return structuredClone(operation);
    const legacy = operation as unknown as Record<string, unknown>;
    const clarification = normalizeClarificationIntent(legacy["clarification"] ?? legacy["slotId"]);
    const historicalSlot = typeof legacy["slotId"] === "string";
    const uncertainty = legacy["uncertainty"] ?? (historicalSlot ? {
      type: clarification.kind === "CANDIDATE_REFERENT" || clarification.kind === "TURN_REPHRASE"
        ? "INTENT_AMBIGUITY"
        : "MISSING_USER_INFORMATION",
      userResolvable: true,
    } : null);
    if (!uncertainty || typeof uncertainty !== "object") {
      throw new DomainError("CLARIFICATION_UNCERTAINTY_REQUIRED", "A clarification must identify a user-resolvable uncertainty");
    }
    const record = uncertainty as Record<string, unknown>;
    if (!(["INTENT_AMBIGUITY", "MISSING_USER_INFORMATION"].includes(String(record["type"]))) || record["userResolvable"] !== true) {
      throw new DomainError("INVALID_CLARIFICATION_UNCERTAINTY", "Clarification uncertainty must be user-resolvable intent or user information");
    }
    const { slotId: _legacySlotId, clarification: _clarification, uncertainty: _uncertainty, ...rest } = legacy;
    return { ...rest, kind: "REQUEST_CLARIFICATION", clarification, uncertainty } as TurnOperation;
  };
  return {
    ops: plan.ops.map(normalizeOperation),
    leftover: plan.leftover.map((item) => ({ ...structuredClone(item), operation: normalizeOperation(item.operation) })),
    userIntentSummary: summary,
  };
}

/** Validates the persistence record for a system-owned failure that occurred
 * before any business plan was approved. This is not an executable TurnPlan. */
export function validateNoPlanDegradedPublication(plan: TurnPlan): TurnPlan {
  const summary = plan.userIntentSummary.trim();
  if (!summary) throw new DomainError("TURN_INTENT_SUMMARY_REQUIRED", "Turn intent summary is required");
  if (plan.ops.length !== 0 || plan.leftover.length !== 0) {
    throw new DomainError("INVALID_NO_PLAN_DEGRADED_PUBLICATION", "A no-plan degraded publication cannot contain operations");
  }
  return { userIntentSummary: summary, ops: [], leftover: [] };
}

export function routeForTurnPlan(input: TurnPlan): ConversationRoute {
  const plan = validateTurnPlan(input);
  if (plan.ops.some((item) => item.kind === "REQUEST_CLARIFICATION")) return "clarify";
  if (plan.ops.some((item) => item.kind === "SEARCH_OFFERS")) return "search";
  if (plan.ops.some((item) => item.kind === "REJECT_OFFERS" || item.kind === "RESTORE_OFFERS" || item.kind === "REFILTER_WORKING_SET")) return "refilter";
  if (plan.ops.some((item) => item.kind === "SORT_WORKING_SET_BY_PRICE")) return "sort";
  return "talk";
}
