import { describe, expect, it } from "vitest";

import { evaluateDevelopmentBehaviorAssertions } from "../src/development-evaluation-assertions.js";
import type { DevelopmentTurnExpectation } from "../src/development-evaluation-cases.js";

const target = {
  categoryId: "headphones",
  targetText: "头戴式耳机",
  canonicalModel: null,
  itemRole: "PRIMARY_PRODUCT",
  condition: "ANY",
};

const expectations: DevelopmentTurnExpectation[] = [
  {
    goal: {
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT" },
      budget: { amount: "3000", currency: "CNY" },
      retrievalMarkets: [],
    },
    clarificationKind: "PURCHASE_MARKET",
    pendingClarification: true,
    allowedOutcomes: ["CLARIFICATION"],
    productSearchCalls: { min: 0, max: 0 },
    planReview: {
      terminalDecision: "APPROVED",
      maxProposals: 2,
      allowedDecisions: ["APPROVED", "REPAIR_REQUIRED"],
    },
  },
  {
    goal: { retrievalMarkets: ["SG", "US"] },
    preservedGoalFields: ["TARGET", "BUDGET"],
    clarificationKind: null,
    pendingClarification: false,
    allowedOutcomes: ["RECOMMENDATION", "SEARCH_RESULTS", "NO_MATCH"],
    productSearchCalls: { min: 2, max: 2 },
    planReview: {
      terminalDecision: "APPROVED",
      maxProposals: 2,
      allowedDecisions: ["APPROVED", "REPAIR_REQUIRED"],
    },
  },
];

function turn(markets: string[], budget = "3000", clarification = false, searchCount = 0) {
  return {
    draft_goal_json: { goal: { target, budget: { amount: budget, currency: "CNY" }, retrievalMarkets: markets } },
    draft_dialogue_json: {
      pendingClarification: clarification
        ? { clarification: { kind: "PURCHASE_MARKET" } }
        : null,
    },
    outcome: clarification ? "CLARIFICATION" : "RECOMMENDATION",
    search: Array.from({ length: searchCount }, (_, index) => ({ market: index === 0 ? "SG" : "US" })),
    planReviews: [{ proposal_number: 1, decision: "APPROVED", violations_json: [] }],
  };
}

describe("development evaluation behavior assertions", () => {
  it("passes a clarification trajectory that preserves known shopping fields", () => {
    const result = evaluateDevelopmentBehaviorAssertions(expectations, [
      turn([], "3000", true, 0),
      turn(["SG", "US"], "3000", false, 2),
    ]);
    expect(result).toEqual({ passed: true, failures: [], checkedTurnCount: 2 });
  });

  it("fails the release assertion when a completed clarification loses the budget", () => {
    const result = evaluateDevelopmentBehaviorAssertions(expectations, [
      turn([], "3000", true, 0),
      turn(["SG", "US"], "2500", false, 2),
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("preserved.BUDGET"),
    ]));
  });

  it("requires bounded plan approval evidence without constraining the model to need repair", () => {
    const repaired: Record<string, any> = turn([], "3000", true, 0);
    repaired.planReviews = [
      { proposal_number: 1, decision: "REPAIR_REQUIRED", violations_json: [{ code: "EXPLICIT_BUDGET_NOT_PLANNED" }] },
      { proposal_number: 2, decision: "APPROVED", violations_json: [] },
    ];
    expect(evaluateDevelopmentBehaviorAssertions([expectations[0]!], [repaired]).passed).toBe(true);

    repaired.planReviews.push({ proposal_number: 3, decision: "APPROVED", violations_json: [] });
    expect(evaluateDevelopmentBehaviorAssertions([expectations[0]!], [repaired]).failures).toEqual(expect.arrayContaining([
      expect.stringContaining("planReview.proposalCount.max"),
    ]));
  });

  it("requires authored goal collection keys without inspecting user-message wording", () => {
    const result = evaluateDevelopmentBehaviorAssertions([{
      goal: { preferenceKeys: ["use_case"], hardConstraintKeys: [] },
    }], [turn(["US"])]);
    expect(result).toMatchObject({
      passed: false,
      failures: [expect.stringContaining("goal.preferenceKeys")],
    });
  });

  it("allows new collection entries while requiring every prior entry and its provenance to survive", () => {
    const first = turn(["SG"]);
    first.draft_goal_json.goal.preferences = [{ key: "use_case", value: "commute", weight: 1, source: { messageId: "first" } }];
    first.draft_goal_json.goal.hardConstraints = [];
    const second = turn(["SG"]);
    second.draft_goal_json.goal.preferences = structuredClone(first.draft_goal_json.goal.preferences);
    second.draft_goal_json.goal.hardConstraints = [{ key: "load_type", operator: "EQ", value: "front_load", source: { messageId: "second" } }];
    expect(evaluateDevelopmentBehaviorAssertions([
      {},
      { preservedGoalFields: ["PREFERENCES", "HARD_CONSTRAINTS"] },
    ], [first, second]).passed).toBe(true);

    second.draft_goal_json.goal.preferences[0]!.source.messageId = "second";
    expect(evaluateDevelopmentBehaviorAssertions([
      {},
      { preservedGoalFields: ["PREFERENCES"] },
    ], [first, second]).failures).toEqual([expect.stringContaining("preserved.PREFERENCES")]);
  });
});
