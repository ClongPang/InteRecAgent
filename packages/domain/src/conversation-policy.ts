import { DomainError } from "./errors.js";
import { applyGoalOperations, emptyShoppingGoal } from "./goal-operations.js";
import { routeForTurnPlan, validateTurnPlan } from "./turn-plan.js";
import { reprojectWorkingSetForGoal } from "./working-set.js";
import type { ConversationRoute, ConversationState, GoalOperation, ShoppingGoal, TurnPlan } from "./conversation-types.js";

export type ResearchNeed = "NOT_NEEDED" | "INSUFFICIENT_COVERAGE" | "STALE" | "USER_REQUESTED_REFRESH";

export interface ConversationPolicyInput {
  plan: TurnPlan;
  state: ConversationState;
  researchNeed: ResearchNeed;
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

export function evaluateConversationPolicy(input: ConversationPolicyInput): ConversationPolicyDecision {
  let plan = validateTurnPlan(input.plan);
  let projectedGoal = applyGoalOperations(
    input.state.goalRevision?.goal ?? emptyShoppingGoal(),
    plan.ops.filter(isGoalOperation),
  );
  let hasResearch = plan.ops.some((operation) => operation.kind === "RESEARCH_OFFERS");
  let hasClarification = plan.ops.some((operation) => operation.kind === "REQUEST_CLARIFICATION");
  const requiredBasicSlot = projectedGoal.target === null
    ? "target_product"
    : projectedGoal.retrievalMarkets.length === 0
      ? "retrieval_markets"
      : null;
  let canonicalizedClarification = false;
  // A provider request cannot repair an incomplete research contract. Convert
  // both an explicit clarification and a premature research request into the
  // same state-derived clarification, while preserving independent Goal edits.
  if ((hasClarification || hasResearch) && requiredBasicSlot) {
    let opId = `host-required-${requiredBasicSlot}`;
    for (let suffix = 2; plan.ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-required-${requiredBasicSlot}-${suffix}`;
    plan = validateTurnPlan({
      ...plan,
      ops: [
        ...plan.ops.filter((operation) => operation.kind !== "REQUEST_CLARIFICATION"
          && operation.kind !== "RESEARCH_OFFERS"
          && !(operation.kind === "GOAL_ADD_GAP" && operation.gap.slotId !== requiredBasicSlot)),
        { opId, kind: "REQUEST_CLARIFICATION", slotId: requiredBasicSlot, reasonCode: "MISSING_REQUIRED_GOAL_FIELD" },
      ],
    });
    projectedGoal = applyGoalOperations(
      input.state.goalRevision?.goal ?? emptyShoppingGoal(),
      plan.ops.filter(isGoalOperation),
    );
    hasResearch = false;
    hasClarification = true;
    canonicalizedClarification = true;
  }
  const baseGoal = input.state.goalRevision?.goal ?? emptyShoppingGoal();
  const changesTarget = plan.ops.some((operation) => operation.kind === "GOAL_SET_TARGET")
    && JSON.stringify(baseGoal.target) !== JSON.stringify(projectedGoal.target);
  const completesInitialResearchGoal = input.state.workingSet === null
    && input.researchNeed === "INSUFFICIENT_COVERAGE"
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
  if (!hasResearch && (completesInitialResearchGoal || completesChangedTargetGoal)) {
    let opId = "host-required-research";
    for (let suffix = 2; plan.ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-required-research-${suffix}`;
    plan = validateTurnPlan({
      ...plan,
      ops: [
        ...plan.ops.filter((operation) => operation.kind !== "REQUEST_CLARIFICATION"),
        { opId, kind: "RESEARCH_OFFERS", reasonCode: completesInitialResearchGoal ? "GOAL_BECAME_RESEARCH_READY" : "TARGET_CHANGED" },
      ],
    });
    projectedGoal = applyGoalOperations(
      input.state.goalRevision?.goal ?? emptyShoppingGoal(),
      plan.ops.filter(isGoalOperation),
    );
    hasResearch = true;
    hasClarification = false;
  }
  let researchOperation = plan.ops.find((operation) => operation.kind === "RESEARCH_OFFERS");

  const goalChanged = plan.ops.some(isGoalOperation);
  const sameResearchContract = JSON.stringify(baseGoal.target) === JSON.stringify(projectedGoal.target)
    && JSON.stringify(baseGoal.hardConstraints) === JSON.stringify(projectedGoal.hardConstraints);
  const reusableProjection = input.state.workingSet && sameResearchContract
    ? reprojectWorkingSetForGoal(input.state.workingSet, projectedGoal)
    : null;
  const explicitRefresh = researchOperation?.kind === "RESEARCH_OFFERS" && researchOperation.reasonCode === "USER_REQUESTED_REFRESH";
  if (hasResearch && goalChanged && !explicitRefresh && reusableProjection && reusableProjection.displayOfferRefs.length > 0) {
    plan = validateTurnPlan({ ...plan, ops: plan.ops.filter((operation) => operation.kind !== "RESEARCH_OFFERS") });
    hasResearch = false;
    researchOperation = undefined;
  }
  const route = routeForTurnPlan(plan);

  if (hasResearch && hasClarification) {
    throw new DomainError("RESEARCH_BEFORE_CLARIFICATION", "A turn cannot call a provider while requesting blocking clarification");
  }
  if (hasResearch && projectedGoal.target === null) {
    throw new DomainError("RESEARCH_TARGET_REQUIRED", "Provider research requires a resolved shopping target");
  }
  if (hasResearch && projectedGoal.retrievalMarkets.length === 0) {
    throw new DomainError("RESEARCH_MARKETS_REQUIRED", "Provider research requires at least one supported retrieval market");
  }
  if (hasResearch && projectedGoal.unresolved.length > 0) {
    throw new DomainError("RESEARCH_BLOCKED_BY_GOAL_GAPS", `Provider research is blocked by unresolved goal slots: ${projectedGoal.unresolved.map((gap) => gap.slotId).join(",")}`);
  }
  const invalidatesEvidence = plan.ops.some((operation) => [
    "GOAL_SET_TARGET",
    "GOAL_CLEAR_TARGET",
    "GOAL_SET_RETRIEVAL_MARKETS",
    "GOAL_SET_STOCK_PREFERENCE",
  ].includes(operation.kind));
  if (hasResearch && input.researchNeed === "NOT_NEEDED" && !invalidatesEvidence && !explicitRefresh) {
    throw new DomainError("UNNECESSARY_PROVIDER_RESEARCH", "Current verified working-set evidence is sufficient; provider research is not allowed");
  }

  return {
    plan,
    route,
    providerCallsAllowed: hasResearch ? 1 : 0,
    projectedGoal,
    reasonCodes: [
      hasResearch ? `RESEARCH_${explicitRefresh ? "USER_REQUESTED_REFRESH" : invalidatesEvidence ? "INSUFFICIENT_COVERAGE" : input.researchNeed}` : "ZERO_PROVIDER_ROUTE",
      ...((completesInitialResearchGoal || completesChangedTargetGoal) && researchOperation ? ["HOST_COMPLETED_RESEARCH_PLAN"] : []),
      ...(canonicalizedClarification ? ["HOST_CANONICALIZED_REQUIRED_CLARIFICATION"] : []),
      ...(hasClarification ? ["BLOCKING_CLARIFICATION"] : []),
    ],
  };
}
