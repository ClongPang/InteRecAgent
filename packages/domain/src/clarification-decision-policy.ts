import { clarificationKey, type ClarificationIntent } from "./clarification.js";
import type { DialogueState, ShoppingGoal, TurnAction } from "./conversation-types.js";
import type { ClarificationUncertaintyType } from "./uncertainty.js";

export type ClarificationDecisionMode =
  | "ASK_BLOCKING"
  | "ASK_OPTIONAL"
  | "ASSUME_AND_DISCLOSE"
  | "SEARCH_THEN_REFINE"
  | "SKIP";

export interface ClarificationDecision {
  mode: ClarificationDecisionMode;
  clarification: ClarificationIntent;
  reasonCodes: string[];
  assumedMarketScope?: string[];
  disclosureCodes?: string[];
}

export interface ClarificationDecisionPolicyInput {
  clarification: ClarificationIntent;
  goal: ShoppingGoal;
  dialogue: DialogueState;
  initialSearchPending: boolean;
  hasWorkingSet: boolean;
}

export interface ClarificationPolicyViolation {
  code: string;
  operationId: string;
  path: string;
  observed: unknown;
  admissibleAlternatives: string[];
}

export type ClarificationPolicyReview =
  | { decision: "APPROVED"; decisionMode: "ASK_BLOCKING" | "ASK_OPTIONAL" }
  | { decision: "REPAIR_REQUIRED"; violations: ClarificationPolicyViolation[] };

export interface ClarificationPolicyReviewInput extends Omit<ClarificationDecisionPolicyInput, "clarification"> {
  operation: Extract<TurnAction, { kind: "REQUEST_CLARIFICATION" }>;
  candidateCount?: number;
}

export const DEFAULT_EXPLORATORY_MARKET_SCOPE = ["US", "SG"] as const;

function wasSkipped(dialogue: DialogueState, clarification: ClarificationIntent): boolean {
  const key = clarificationKey(clarification);
  return (dialogue.clarificationHistory ?? []).some((item) => item.outcome === "SKIPPED" && clarificationKey(item.clarification) === key);
}

function higherPriorityInitialClarification(input: ClarificationDecisionPolicyInput): ClarificationIntent["kind"] | null {
  if (!input.initialSearchPending) return null;
  if (!input.goal.target) return "TARGET_PRODUCT";
  if (input.goal.retrievalMarkets.length === 0
    && !wasSkipped(input.dialogue, { kind: "PURCHASE_MARKET" })) return "PURCHASE_MARKET";
  return null;
}

export function evaluateClarificationDecision(input: ClarificationDecisionPolicyInput): ClarificationDecision {
  const { clarification, goal } = input;
  if (clarification.kind === "TARGET_PRODUCT") {
    return goal.target
      ? { mode: "SKIP", clarification, reasonCodes: ["TARGET_ALREADY_KNOWN"] }
      : { mode: "ASK_BLOCKING", clarification, reasonCodes: ["SEARCH_TARGET_REQUIRED"] };
  }
  if (clarification.kind === "PURCHASE_MARKET") {
    if (goal.retrievalMarkets.length > 0) return { mode: "SKIP", clarification, reasonCodes: ["PURCHASE_MARKET_ALREADY_KNOWN"] };
    if (wasSkipped(input.dialogue, clarification)) {
      return {
        mode: "SEARCH_THEN_REFINE",
        clarification,
        reasonCodes: ["USER_SKIPPED_PURCHASE_MARKET", "EXPLORATORY_MARKET_SCOPE"],
        assumedMarketScope: [...DEFAULT_EXPLORATORY_MARKET_SCOPE],
        disclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
      };
    }
    return { mode: "ASK_BLOCKING", clarification, reasonCodes: ["PURCHASE_MARKET_REQUIRED_FOR_SEARCH"] };
  }
  if (clarification.kind === "CONDITION" && goal.target?.condition === "ANY" && input.initialSearchPending) {
    return {
      mode: "ASSUME_AND_DISCLOSE",
      clarification,
      reasonCodes: ["CONDITION_DEFAULT_ANY"],
      disclosureCodes: ["PRODUCT_CONDITION_NOT_RESTRICTED"],
    };
  }
  if (wasSkipped(input.dialogue, clarification)) {
    return { mode: "SKIP", clarification, reasonCodes: ["USER_ALREADY_SKIPPED"] };
  }
  if (input.initialSearchPending && goal.target && goal.retrievalMarkets.length > 0) {
    return { mode: "SKIP", clarification, reasonCodes: ["OPTIONAL_DETAIL_DOES_NOT_BLOCK_INITIAL_SEARCH"] };
  }
  return {
    mode: "ASK_OPTIONAL",
    clarification,
    reasonCodes: [input.hasWorkingSet ? "OPTIONAL_REFINEMENT_AFTER_RESULTS" : "OPTIONAL_HIGH_VALUE_DETAIL"],
  };
}

function allowedUncertaintyTypes(clarification: ClarificationIntent): readonly ClarificationUncertaintyType[] {
  if (clarification.kind === "CANDIDATE_REFERENT" || clarification.kind === "TURN_REPHRASE") return ["INTENT_AMBIGUITY"];
  if (clarification.kind === "TARGET_PRODUCT" || clarification.kind === "TARGET_MODEL") {
    return ["MISSING_USER_INFORMATION", "INTENT_AMBIGUITY"];
  }
  return ["MISSING_USER_INFORMATION"];
}

/** Pure clarification authorization. It never adds, removes, or rewrites a
 * Turn operation; repair remains the proposing Pi-Agent's responsibility. */
export function reviewClarificationRequest(input: ClarificationPolicyReviewInput): ClarificationPolicyReview {
  const { operation } = input;
  if (operation.clarification.kind === "TURN_REPHRASE") {
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "GENERIC_REPHRASE_NOT_ACTIONABLE",
        operationId: operation.opId,
        path: `ops.${operation.opId}.clarification.kind`,
        observed: operation.clarification.kind,
        admissibleAlternatives: [
          "Name the concrete registered information gap the user can resolve.",
          "If planning, protocol, tool, or evidence processing failed, publish a system-owned degraded result instead of clarification.",
        ],
      }],
    };
  }
  const candidateCount = input.candidateCount ?? (input.hasWorkingSet ? 2 : 0);
  if ((operation.clarification.kind === "TARGET_PRODUCT" || operation.clarification.kind === "TARGET_MODEL")
    && operation.uncertainty.type === "INTENT_AMBIGUITY"
    && !operation.clarification.interpretations) {
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "CLARIFICATION_INTERPRETATIONS_REQUIRED",
        operationId: operation.opId,
        path: `ops.${operation.opId}.clarification.interpretations`,
        observed: operation.clarification,
        admissibleAlternatives: [
          "Provide 2-4 concise, user-grounded interpretations for the ambiguous target.",
          "If there are not multiple plausible meanings, use MISSING_USER_INFORMATION without interpretations.",
        ],
      }],
    };
  }
  if (operation.clarification.kind === "CANDIDATE_REFERENT" && candidateCount === 0) {
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "CANDIDATE_REFERENT_CONTEXT_REQUIRED",
        operationId: operation.opId,
        path: `ops.${operation.opId}.clarification`,
        observed: operation.clarification,
        admissibleAlternatives: [
          "Remove the candidate clarification because no current candidate set exists.",
          "Plan the user-requested search first; candidate referents can be clarified only after candidates exist.",
        ],
      }],
    };
  }
  if (operation.clarification.kind === "CANDIDATE_REFERENT" && candidateCount === 1) {
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "CANDIDATE_REFERENT_NOT_AMBIGUOUS",
        operationId: operation.opId,
        path: `ops.${operation.opId}.clarification`,
        observed: { clarification: operation.clarification, candidateCount },
        admissibleAlternatives: [
          "Use the only remaining candidate without asking which candidate the user means.",
          "If the requested comparison needs more candidates, retrieve evidence or disclose that the current candidate set is insufficient.",
        ],
      }],
    };
  }
  const requiredKind = higherPriorityInitialClarification({
    clarification: operation.clarification,
    goal: input.goal,
    dialogue: input.dialogue,
    initialSearchPending: input.initialSearchPending,
    hasWorkingSet: input.hasWorkingSet,
  });
  const clarifiesPossiblyProvisionalTarget = (operation.clarification.kind === "TARGET_PRODUCT"
    || operation.clarification.kind === "TARGET_MODEL")
    && operation.uncertainty.type === "INTENT_AMBIGUITY";
  const addressesRequiredKind = requiredKind === "TARGET_PRODUCT"
    ? operation.clarification.kind === "TARGET_PRODUCT" || operation.clarification.kind === "TARGET_MODEL"
    : operation.clarification.kind === requiredKind || clarifiesPossiblyProvisionalTarget;
  if (requiredKind && !addressesRequiredKind) {
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "HIGHER_PRIORITY_CLARIFICATION_REQUIRED",
        operationId: operation.opId,
        path: `ops.${operation.opId}.clarification.kind`,
        observed: { requestedKind: operation.clarification.kind, requiredKind },
        admissibleAlternatives: [
          `Request ${requiredKind} because it currently blocks the initial offer search.`,
          "Defer optional product refinements until the minimum search-ready goal is available.",
        ],
      }],
    };
  }
  const allowed = allowedUncertaintyTypes(operation.clarification);
  if (operation.uncertainty.userResolvable !== true || !allowed.includes(operation.uncertainty.type)) {
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "CLARIFICATION_UNCERTAINTY_MISMATCH",
        operationId: operation.opId,
        path: `ops.${operation.opId}.uncertainty`,
        observed: operation.uncertainty,
        admissibleAlternatives: [
          `Use ${allowed.join(" or ")} with userResolvable=true for ${operation.clarification.kind}.`,
          "Use retrieval/disclosure for MISSING_EVIDENCE and retry/degrade for SYSTEM_FAILURE.",
        ],
      }],
    };
  }
  const decision = evaluateClarificationDecision({
    clarification: operation.clarification,
    goal: input.goal,
    dialogue: input.dialogue,
    initialSearchPending: input.initialSearchPending,
    hasWorkingSet: input.hasWorkingSet,
  });
  if (decision.mode !== "ASK_BLOCKING" && decision.mode !== "ASK_OPTIONAL") {
    const targetWasPrematurelyResolved = (operation.clarification.kind === "TARGET_PRODUCT" || operation.clarification.kind === "TARGET_MODEL")
      && decision.reasonCodes.some((code) => code === "TARGET_ALREADY_KNOWN");
    return {
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "CLARIFICATION_NOT_DECISION_RELEVANT",
        operationId: operation.opId,
        path: `ops.${operation.opId}`,
        observed: { clarification: operation.clarification, decisionMode: decision.mode, reasonCodes: decision.reasonCodes },
        admissibleAlternatives: targetWasPrematurelyResolved
          ? [
            "If GOAL_SET_TARGET is only a provisional interpretation of ambiguous user language, remove that goal operation and keep the target clarification.",
            "If the target is genuinely explicit, remove the redundant clarification and continue with the confirmed target.",
          ]
          : [
            "Remove the clarification and continue with the currently sufficient shopping state.",
            "Search first and refine later when the missing preference is optional.",
          ],
      }],
    };
  }
  return { decision: "APPROVED", decisionMode: decision.mode };
}
