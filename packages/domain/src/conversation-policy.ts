import { DomainError } from "./errors.js";
import { applyGoalOperations, emptyShoppingGoal } from "./goal-operations.js";
import { routeForTurnPlan, validateTurnPlan } from "./turn-plan.js";
import { reprojectWorkingSetForGoal } from "./working-set.js";
import type { ConversationRoute, ConversationState, GoalOperation, ShoppingGoal, TurnPlan } from "./conversation-types.js";

export type SearchNeed = "NOT_NEEDED" | "INSUFFICIENT_COVERAGE" | "STALE" | "USER_REQUESTED_REFRESH";

export interface ConversationPolicyInput {
  plan: TurnPlan;
  state: ConversationState;
  searchNeed: SearchNeed;
}

export interface ConversationPolicyDecision {
  plan: TurnPlan;
  route: ConversationRoute;
  providerCallsAllowed: 0 | 1;
  projectedGoal: ShoppingGoal;
  reasonCodes: string[];
}

function isGoalOperation(operation: TurnPlan["ops"][number]): operation is GoalOperation {
  return operation.kind.startsWith("GOAL_");
}

/**
 * Validates a Pi-Agent plan without changing its semantic operations. Missing
 * or conflicting actions are reported as domain errors and converted to typed
 * PlanReview feedback by the caller.
 */
export function evaluateConversationPolicy(input: ConversationPolicyInput): ConversationPolicyDecision {
  const plan = validateTurnPlan(input.plan);
  const projectedGoal = applyGoalOperations(
    input.state.goalRevision?.goal ?? emptyShoppingGoal(),
    plan.ops.filter(isGoalOperation),
  );
  const baseGoal = input.state.goalRevision?.goal ?? emptyShoppingGoal();
  const hasSearch = plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS");
  const hasClarification = plan.ops.some((operation) => operation.kind === "REQUEST_CLARIFICATION");
  const searchAction = plan.ops.find((operation) => operation.kind === "SEARCH_OFFERS");
  const explicitRefresh = searchAction?.kind === "SEARCH_OFFERS" && searchAction.reasonCode === "USER_REQUESTED_REFRESH";
  const startsInitialShoppingGoal = input.state.workingSet === null
    && input.searchNeed === "INSUFFICIENT_COVERAGE"
    && plan.ops.some((operation) => isGoalOperation(operation));
  const skippedPurchaseMarket = (input.state.dialogue.clarificationHistory ?? []).some((item) =>
    item.outcome === "SKIPPED" && item.clarification.kind === "PURCHASE_MARKET")
    || plan.ops.some((operation) => operation.kind === "RESOLVE_CLARIFICATION"
      && operation.outcome === "SKIPPED"
      && operation.clarification.kind === "PURCHASE_MARKET");
  const projectedWorkingSet = input.state.workingSet
    ? reprojectWorkingSetForGoal(input.state.workingSet, projectedGoal)
    : null;
  const candidateAction = plan.ops.find((operation) => [
    "REJECT_OFFERS",
    "SET_COMPARISON",
    "INSPECT_WORKING_SET",
    "REFILTER_WORKING_SET",
    "SORT_WORKING_SET_BY_PRICE",
  ].includes(operation.kind) || (operation.kind === "SET_FOCUS" && operation.referent !== null));

  if (hasSearch && hasClarification) {
    throw new DomainError("SEARCH_BEFORE_CLARIFICATION", "A turn cannot call a provider while requesting blocking clarification");
  }
  if (startsInitialShoppingGoal && !hasSearch && !hasClarification && projectedGoal.target === null) {
    throw new DomainError(
      "TARGET_CLARIFICATION_REQUIRED",
      "The initial shopping goal is missing a target and the proposed plan omitted concrete target clarification",
    );
  }
  if (startsInitialShoppingGoal && !hasSearch && !hasClarification && projectedGoal.retrievalMarkets.length === 0) {
    throw new DomainError(
      "PURCHASE_MARKET_CLARIFICATION_REQUIRED",
      "The initial shopping goal is missing a purchase market and the proposed plan omitted concrete market clarification",
    );
  }
  if (candidateAction && (projectedWorkingSet?.pool.length ?? 0) === 0) {
    throw new DomainError(
      "CANDIDATE_SET_REQUIRED",
      `Candidate operation ${candidateAction.kind} requires a non-empty projected candidate set`,
    );
  }
  if (hasSearch && projectedGoal.target === null) {
    throw new DomainError("SEARCH_TARGET_REQUIRED", "Provider search requires a resolved shopping target");
  }
  if (hasSearch && projectedGoal.retrievalMarkets.length === 0
    && !(searchAction?.kind === "SEARCH_OFFERS" && (searchAction.marketScope?.length ?? 0) > 0)) {
    throw new DomainError("SEARCH_MARKETS_REQUIRED", "Provider search requires at least one supported retrieval market");
  }
  if (searchAction?.kind === "SEARCH_OFFERS" && searchAction.marketScope) {
    const scope = [...searchAction.marketScope].sort();
    if (projectedGoal.retrievalMarkets.length > 0) {
      throw new DomainError(
        "SEARCH_MARKET_SCOPE_REDUNDANT",
        "An exploratory marketScope must not override or duplicate explicit retrieval markets",
      );
    }
    if (!skippedPurchaseMarket) {
      throw new DomainError(
        "EXPLORATORY_MARKET_SCOPE_NOT_AUTHORIZED",
        "Exploratory market scope is allowed only after the user skips purchase-market clarification",
      );
    }
    if (JSON.stringify(scope) !== JSON.stringify(["SG", "US"])
      || !searchAction.assumptionDisclosureCodes?.includes("PURCHASE_MARKET_SCOPE_ASSUMED")) {
      throw new DomainError(
        "EXPLORATORY_MARKET_SCOPE_INVALID",
        "An authorized exploratory market scope must be US/SG and disclose the assumption",
      );
    }
  }
  if (searchAction?.kind === "SEARCH_OFFERS"
    && searchAction.assumptionDisclosureCodes?.includes("PRODUCT_CONDITION_NOT_RESTRICTED")
    && projectedGoal.target?.condition !== "ANY") {
    throw new DomainError(
      "CONDITION_ASSUMPTION_DISCLOSURE_MISMATCH",
      "Unrestricted-condition disclosure is valid only when product condition is ANY",
    );
  }
  if (hasSearch && projectedGoal.unresolved.length > 0) {
    throw new DomainError(
      "SEARCH_BLOCKED_BY_GOAL_GAPS",
      `Provider search is blocked by unresolved goal slots: ${projectedGoal.unresolved.map((gap) => gap.slotId).join(",")}`,
    );
  }

  const changesTarget = plan.ops.some((operation) => operation.kind === "GOAL_SET_TARGET")
    && JSON.stringify(baseGoal.target) !== JSON.stringify(projectedGoal.target);
  const completesInitialSearchGoal = input.state.workingSet === null
    && input.searchNeed === "INSUFFICIENT_COVERAGE"
    && plan.ops.some((operation) => isGoalOperation(operation) && [
      "GOAL_SET_TARGET",
      "GOAL_SET_BUDGET",
      "GOAL_SET_RETRIEVAL_MARKETS",
      "GOAL_RESOLVE_GAP",
    ].includes(operation.kind))
    && projectedGoal.target !== null
    && projectedGoal.retrievalMarkets.length > 0
    && projectedGoal.unresolved.length === 0;
  const completesChangedTargetGoal = changesTarget
    && projectedGoal.target !== null
    && projectedGoal.target.canonicalModel !== null
    && projectedGoal.retrievalMarkets.length > 0
    && projectedGoal.unresolved.length === 0;
  if (!hasSearch && !hasClarification && (completesInitialSearchGoal || completesChangedTargetGoal)) {
    throw new DomainError(
      "SEARCH_OPERATION_REQUIRED",
      completesInitialSearchGoal
        ? "The goal became search-ready but the proposed plan omitted SEARCH_OFFERS"
        : "The target changed and invalidated current evidence but the proposed plan omitted SEARCH_OFFERS",
    );
  }

  const goalChanged = plan.ops.some(isGoalOperation);
  const sameSearchInputs = JSON.stringify(baseGoal.target) === JSON.stringify(projectedGoal.target)
    && JSON.stringify(baseGoal.hardConstraints) === JSON.stringify(projectedGoal.hardConstraints);
  const reusableProjection = input.state.workingSet && sameSearchInputs
    ? reprojectWorkingSetForGoal(input.state.workingSet, projectedGoal)
    : null;
  if (hasSearch && goalChanged && !explicitRefresh && reusableProjection && reusableProjection.displayOfferRefs.length > 0) {
    throw new DomainError(
      "UNNECESSARY_PROVIDER_SEARCH",
      "The current grounded working set can satisfy this goal change without another provider request",
    );
  }

  const invalidatesEvidence = plan.ops.some((operation) => [
    "GOAL_SET_TARGET",
    "GOAL_CLEAR_TARGET",
    "GOAL_SET_RETRIEVAL_MARKETS",
    "GOAL_SET_STOCK_PREFERENCE",
  ].includes(operation.kind));
  if (hasSearch && input.searchNeed === "NOT_NEEDED" && !invalidatesEvidence && !explicitRefresh) {
    throw new DomainError("UNNECESSARY_PROVIDER_SEARCH", "Current grounded working-set evidence is sufficient; provider search is not allowed");
  }

  return {
    plan,
    route: routeForTurnPlan(plan),
    providerCallsAllowed: hasSearch ? 1 : 0,
    projectedGoal,
    reasonCodes: [
      hasSearch
        ? `SEARCH_${explicitRefresh ? "USER_REQUESTED_REFRESH" : invalidatesEvidence ? "INSUFFICIENT_COVERAGE" : input.searchNeed}`
        : "ZERO_PROVIDER_ROUTE",
      ...(hasClarification ? ["BLOCKING_CLARIFICATION"] : []),
    ],
  };
}
