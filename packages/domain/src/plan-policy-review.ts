import { DomainError } from "./errors.js";
import { applyGoalOperations, emptyShoppingGoal } from "./goal-operations.js";
import { applyDialogueOperations } from "./dialogue-state.js";
import { reviewClarificationRequest } from "./clarification-decision-policy.js";
import { identityQualifierMatchesTarget, resolveCategoryValidationPolicy } from "./catalog-validation-policies.js";
import {
  evaluateConversationPolicy,
  type ConversationPolicyDecision,
  type ConversationPolicyInput,
} from "./conversation-policy.js";
import type { TurnPlan } from "./conversation-types.js";
import { routeForTurnPlan } from "./turn-plan.js";
import { reprojectWorkingSetForGoal } from "./working-set.js";

export const CONVERSATION_PLAN_POLICY_VERSION = "2026-08-31.7";

export interface PlanPolicyViolation {
  code: string;
  operationId: string | null;
  path: string;
  observed: unknown;
  admissibleAlternatives: string[];
}

export type ApprovedPlanReview = {
  decision: "APPROVED";
  policyVersion: string;
};

export type RepairRequiredPlanReview = {
  decision: "REPAIR_REQUIRED";
  policyVersion: string;
  violations: PlanPolicyViolation[];
};

export type RejectedPlanReview = {
  decision: "REJECTED";
  policyVersion: string;
  failureOwner: "SYSTEM";
  violations: PlanPolicyViolation[];
};

export type PlanReview = ApprovedPlanReview | RepairRequiredPlanReview | RejectedPlanReview;
export type UnapprovedPlanReview = Exclude<PlanReview, ApprovedPlanReview>;

export type ConversationPlanReviewResult =
  | { review: ApprovedPlanReview; policyDecision: ConversationPolicyDecision }
  | { review: RepairRequiredPlanReview };

function operationKinds(plan: TurnPlan): string[] {
  return plan.ops.map((operation) => operation.kind);
}

function alternativesForDomainError(code: string): string[] {
  switch (code) {
    case "SEARCH_BEFORE_CLARIFICATION":
      return ["Remove SEARCH_OFFERS while a blocking clarification is requested.", "Resolve the information gap and submit SEARCH_OFFERS in a later plan."];
    case "SEARCH_TARGET_REQUIRED":
      return ["Add an evidenced GOAL_SET_TARGET before SEARCH_OFFERS.", "Request TARGET_PRODUCT clarification instead of searching."];
    case "SEARCH_MARKETS_REQUIRED":
      return ["Add an evidenced GOAL_SET_RETRIEVAL_MARKETS before SEARCH_OFFERS.", "Request PURCHASE_MARKET clarification instead of searching."];
    case "TARGET_CLARIFICATION_REQUIRED":
      return ["Add one REQUEST_CLARIFICATION for TARGET_PRODUCT with MISSING_USER_INFORMATION and userResolvable=true."];
    case "PURCHASE_MARKET_CLARIFICATION_REQUIRED":
      return ["Add one REQUEST_CLARIFICATION for PURCHASE_MARKET with MISSING_USER_INFORMATION and userResolvable=true."];
    case "CANDIDATE_SET_REQUIRED":
      return ["Add SEARCH_OFFERS when the current goal has no candidate evidence.", "Otherwise remove candidate operations and disclose that the current candidate set is insufficient."];
    case "SEARCH_BLOCKED_BY_GOAL_GAPS":
      return ["Resolve the blocking goal gap before SEARCH_OFFERS.", "Request the user-resolvable missing information instead of searching."];
    case "UNNECESSARY_PROVIDER_SEARCH":
      return ["Remove SEARCH_OFFERS and use the current grounded working set.", "Use USER_REQUESTED_REFRESH only when the user explicitly requested a refresh."];
    case "SEARCH_OPERATION_REQUIRED":
      return ["Add SEARCH_OFFERS after the goal becomes search-ready.", "If a user-resolvable required input is still missing, request that concrete clarification instead."];
    case "EXPLORATORY_MARKET_SCOPE_NOT_AUTHORIZED":
      return ["Request PURCHASE_MARKET clarification.", "After the user explicitly skips it, propose US/SG marketScope with PURCHASE_MARKET_SCOPE_ASSUMED disclosure."];
    case "SEARCH_MARKET_SCOPE_REDUNDANT":
      return ["Remove marketScope and PURCHASE_MARKET_SCOPE_ASSUMED; SEARCH_OFFERS will use the explicit retrieval markets already present in the goal."];
    case "EXPLORATORY_MARKET_SCOPE_INVALID":
      return ["Use exactly US/SG marketScope with PURCHASE_MARKET_SCOPE_ASSUMED after an explicit skip.", "Otherwise request PURCHASE_MARKET clarification without searching."];
    case "CONDITION_ASSUMPTION_DISCLOSURE_MISMATCH":
      return ["Remove PRODUCT_CONDITION_NOT_RESTRICTED when condition is known.", "Use that disclosure only when target condition is ANY."];
    default:
      return ["Resubmit a plan that satisfies the named policy invariant."];
  }
}

/** Reviews a semantic plan without changing it. */
export function reviewConversationPlan(input: ConversationPolicyInput): ConversationPlanReviewResult {
  try {
    const clarificationResolution = input.plan.ops.find((operation) => operation.kind === "RESOLVE_CLARIFICATION");
    const dialogue = clarificationResolution?.kind === "RESOLVE_CLARIFICATION"
      ? applyDialogueOperations(input.state.dialogue, [{
        kind: "DIALOGUE_RECORD_CLARIFICATION_OUTCOME",
        clarification: clarificationResolution.clarification,
        outcome: clarificationResolution.outcome,
        goalVersion: input.state.goalRevision?.version ?? null,
      }])
      : input.state.dialogue;
    const goal = applyGoalOperations(
      input.state.goalRevision?.goal ?? emptyShoppingGoal(),
      input.plan.ops.filter((operation) => operation.kind.startsWith("GOAL_")) as Parameters<typeof applyGoalOperations>[1],
    );
    const projectedWorkingSet = input.state.workingSet
      ? reprojectWorkingSetForGoal(input.state.workingSet, goal)
      : null;
    const candidateCount = projectedWorkingSet?.displayOfferRefs.length ?? 0;
    const projectedTarget = goal.target;
    const targetPolicy = projectedTarget ? resolveCategoryValidationPolicy(projectedTarget.categoryId) : null;
    const duplicateIdentityAttributes = targetPolicy && projectedTarget
      ? input.plan.ops.flatMap((operation) => {
        const attribute = operation.kind === "GOAL_UPSERT_CONSTRAINT"
          ? operation.constraint
          : operation.kind === "GOAL_UPSERT_PREFERENCE"
            ? operation.preference
            : null;
        if (!attribute || !identityQualifierMatchesTarget(targetPolicy, attribute.key, attribute.value, projectedTarget.targetText)) return [];
        return [{
          code: "TARGET_IDENTITY_ATTRIBUTE_DUPLICATED",
          operationId: operation.opId,
          path: `ops.${operation.opId}.${operation.kind === "GOAL_UPSERT_CONSTRAINT" ? "constraint" : "preference"}`,
          observed: { key: attribute.key, value: attribute.value, targetText: projectedTarget.targetText },
          admissibleAlternatives: [
            "Keep the identity qualifier in targetText and remove the duplicate constraint or preference operation.",
            "Use a constraint or preference only for a requirement independent of the requested product identity.",
          ],
        } satisfies PlanPolicyViolation];
      })
      : [];
    if (duplicateIdentityAttributes.length > 0) {
      return {
        review: {
          decision: "REPAIR_REQUIRED",
          policyVersion: CONVERSATION_PLAN_POLICY_VERSION,
          violations: duplicateIdentityAttributes,
        },
      };
    }
    for (const operation of input.plan.ops) {
      if (operation.kind !== "REQUEST_CLARIFICATION") continue;
      const clarificationReview = reviewClarificationRequest({
        operation,
        goal,
        dialogue,
        initialSearchPending: input.state.workingSet === null && input.searchNeed === "INSUFFICIENT_COVERAGE",
        hasWorkingSet: candidateCount > 0,
        candidateCount,
      });
      if (clarificationReview.decision === "REPAIR_REQUIRED") {
        return {
          review: {
            decision: "REPAIR_REQUIRED",
            policyVersion: CONVERSATION_PLAN_POLICY_VERSION,
            violations: clarificationReview.violations,
          },
        };
      }
    }
    const policyDecision = evaluateConversationPolicy(input);
    return {
      review: { decision: "APPROVED", policyVersion: CONVERSATION_PLAN_POLICY_VERSION },
      policyDecision,
    };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      review: {
        decision: "REPAIR_REQUIRED",
        policyVersion: CONVERSATION_PLAN_POLICY_VERSION,
        violations: [{
          code: error.code,
          operationId: input.plan.ops.find((operation) => operation.kind === "SEARCH_OFFERS")?.opId ?? null,
          path: "ops",
          observed: { operationKinds: operationKinds(input.plan) },
          admissibleAlternatives: alternativesForDomainError(error.code),
        }],
      },
    };
  }
}

/** Structured UI operations are already authoritative typed commands. A
 * local-only command is approved as submitted instead of being expanded into
 * a natural-language shopping workflow. Provider and clarification plans still
 * pass through the complete conversation policy review. */
export function reviewStructuredConversationPlan(input: ConversationPolicyInput): ConversationPlanReviewResult {
  const requiresFullReview = input.plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS"
    || operation.kind === "REQUEST_CLARIFICATION");
  if (requiresFullReview) return reviewConversationPlan(input);
  const projectedGoal = applyGoalOperations(
    input.state.goalRevision?.goal ?? emptyShoppingGoal(),
    input.plan.ops.filter((operation) => operation.kind.startsWith("GOAL_")) as Parameters<typeof applyGoalOperations>[1],
  );
  return {
    review: { decision: "APPROVED", policyVersion: CONVERSATION_PLAN_POLICY_VERSION },
    policyDecision: {
      plan: input.plan,
      route: routeForTurnPlan(input.plan),
      providerCallsAllowed: 0,
      projectedGoal,
      reasonCodes: ["STRUCTURED_INPUT_ZERO_PROVIDER_ROUTE"],
    },
  };
}
