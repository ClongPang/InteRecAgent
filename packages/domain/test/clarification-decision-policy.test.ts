import { describe, expect, it } from "vitest";

import {
  applyDialogueOperations,
  emptyDialogueState,
  emptyShoppingGoal,
  evaluateClarificationDecision,
  reviewClarificationRequest,
} from "../src/index.js";

describe("ClarificationDecisionPolicy", () => {
  it("classifies blocking, optional, assumed, search-then-refine, and skipped decisions", () => {
    const emptyGoal = emptyShoppingGoal();
    const dialogue = emptyDialogueState();
    expect(evaluateClarificationDecision({
      clarification: { kind: "TARGET_PRODUCT" }, goal: emptyGoal, dialogue, initialSearchPending: true, hasWorkingSet: false,
    }).mode).toBe("ASK_BLOCKING");

    expect(evaluateClarificationDecision({
      clarification: { kind: "BUDGET" }, goal: emptyGoal, dialogue, initialSearchPending: false, hasWorkingSet: false,
    }).mode).toBe("ASK_OPTIONAL");

    const searchableGoal = {
      ...emptyGoal,
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT" as const, condition: "ANY" as const },
      retrievalMarkets: ["US"],
    };
    expect(evaluateClarificationDecision({
      clarification: { kind: "CONDITION" }, goal: searchableGoal, dialogue, initialSearchPending: true, hasWorkingSet: false,
    })).toMatchObject({ mode: "ASSUME_AND_DISCLOSE", disclosureCodes: ["PRODUCT_CONDITION_NOT_RESTRICTED"] });

    const marketSkipped = applyDialogueOperations(dialogue, [{
      kind: "DIALOGUE_RECORD_CLARIFICATION_OUTCOME",
      clarification: { kind: "PURCHASE_MARKET" },
      outcome: "SKIPPED",
      goalVersion: 1,
    }]);
    expect(evaluateClarificationDecision({
      clarification: { kind: "PURCHASE_MARKET" },
      goal: { ...searchableGoal, retrievalMarkets: [] },
      dialogue: marketSkipped,
      initialSearchPending: true,
      hasWorkingSet: false,
    })).toMatchObject({ mode: "SEARCH_THEN_REFINE", assumedMarketScope: ["US", "SG"] });

    const budgetSkipped = applyDialogueOperations(dialogue, [{
      kind: "DIALOGUE_RECORD_CLARIFICATION_OUTCOME",
      clarification: { kind: "BUDGET" },
      outcome: "SKIPPED",
      goalVersion: 1,
    }]);
    const first = evaluateClarificationDecision({
      clarification: { kind: "BUDGET" }, goal: searchableGoal, dialogue: budgetSkipped, initialSearchPending: false, hasWorkingSet: true,
    });
    const repeated = evaluateClarificationDecision({
      clarification: { kind: "BUDGET" }, goal: searchableGoal, dialogue: budgetSkipped, initialSearchPending: false, hasWorkingSet: true,
    });
    expect(first.mode).toBe("SKIP");
    expect(repeated.mode).toBe("SKIP");
  });

  it("approves only a correctly attributed user-resolvable information gap", () => {
    expect(reviewClarificationRequest({
      operation: {
        opId: "ask-target",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "TARGET_PRODUCT", interpretations: ["fresh fruit", "Apple electronic product"] },
        uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
        reasonCode: "SEARCH_TARGET_REQUIRED",
      },
      goal: emptyShoppingGoal(),
      dialogue: emptyDialogueState(),
      initialSearchPending: true,
      hasWorkingSet: false,
    })).toEqual({ decision: "APPROVED", decisionMode: "ASK_BLOCKING" });

    expect(reviewClarificationRequest({
      operation: {
        opId: "disambiguate-target",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "TARGET_PRODUCT", interpretations: ["fresh fruit", "Apple electronic product"] },
        uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true },
        reasonCode: "AMBIGUOUS_PRODUCT_MEANING",
      },
      goal: emptyShoppingGoal(),
      dialogue: emptyDialogueState(),
      initialSearchPending: true,
      hasWorkingSet: false,
    })).toEqual({ decision: "APPROVED", decisionMode: "ASK_BLOCKING" });
  });

  it("requires execution-blocking fields before optional initial refinements", () => {
    const goal = {
      ...emptyShoppingGoal(),
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT" as const, condition: "ANY" as const },
    };
    expect(reviewClarificationRequest({
      operation: {
        opId: "ask-form-factor",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "FORM_FACTOR" },
        uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
        reasonCode: "FORM_FACTOR_NOT_SPECIFIED",
      },
      goal,
      dialogue: emptyDialogueState(),
      initialSearchPending: true,
      hasWorkingSet: false,
    })).toMatchObject({
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "HIGHER_PRIORITY_CLARIFICATION_REQUIRED",
        observed: { requestedKind: "FORM_FACTOR", requiredKind: "PURCHASE_MARKET" },
      }],
    });
  });

  it("directs repair to remove a provisional target instead of deleting necessary disambiguation", () => {
    const result = reviewClarificationRequest({
      operation: {
        opId: "disambiguate-target",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "TARGET_PRODUCT", interpretations: ["fresh fruit", "Apple electronic product"] },
        uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true },
        reasonCode: "AMBIGUOUS_PRODUCT_MEANING",
      },
      goal: {
        ...emptyShoppingGoal(),
        target: { categoryId: "provisional", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      },
      dialogue: emptyDialogueState(),
      initialSearchPending: true,
      hasWorkingSet: false,
    });
    expect(result).toMatchObject({
      decision: "REPAIR_REQUIRED",
      violations: [{
        code: "CLARIFICATION_NOT_DECISION_RELEVANT",
        admissibleAlternatives: expect.arrayContaining([expect.stringContaining("provisional interpretation")]),
      }],
    });
  });

  it("rejects generic rephrasing and incorrectly attributed candidate ambiguity", () => {
    const base = {
      goal: emptyShoppingGoal(),
      dialogue: emptyDialogueState(),
      initialSearchPending: false,
      hasWorkingSet: false,
    };
    expect(reviewClarificationRequest({
      ...base,
      operation: {
        opId: "rephrase",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "TURN_REPHRASE" },
        uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true },
        reasonCode: "MODEL_PROTOCOL_FAILED",
      },
    })).toMatchObject({ decision: "REPAIR_REQUIRED", violations: [{ code: "GENERIC_REPHRASE_NOT_ACTIONABLE" }] });
    expect(reviewClarificationRequest({
      ...base,
      hasWorkingSet: true,
      operation: {
        opId: "referent",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "CANDIDATE_REFERENT", contextRef: "compare" },
        uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
        reasonCode: "CANDIDATE_REFERENT_AMBIGUOUS",
      },
    })).toMatchObject({ decision: "REPAIR_REQUIRED", violations: [{ code: "CLARIFICATION_UNCERTAINTY_MISMATCH" }] });
  });

  it("does not manufacture candidate ambiguity when only one candidate remains", () => {
    expect(reviewClarificationRequest({
      goal: emptyShoppingGoal(),
      dialogue: emptyDialogueState(),
      initialSearchPending: false,
      hasWorkingSet: true,
      candidateCount: 1,
      operation: {
        opId: "referent",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "CANDIDATE_REFERENT", contextRef: "compare" },
        uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true },
        reasonCode: "SECOND_CANDIDATE_UNAVAILABLE",
      },
    })).toMatchObject({ decision: "REPAIR_REQUIRED", violations: [{ code: "CANDIDATE_REFERENT_NOT_AMBIGUOUS" }] });
  });
});
