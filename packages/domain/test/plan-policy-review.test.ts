import { describe, expect, it } from "vitest";

import {
  createGoalRevision,
  createWorkingSet,
  emptyDialogueState,
  reviewConversationPlan,
  type ConversationState,
  type TurnPlan,
} from "../src/index.js";

const source = { messageId: "message-1" };

function stateWithTargetAndMarket(): ConversationState {
  return {
    revision: 1,
    status: "OPEN",
    goalRevision: createGoalRevision(null, [
      {
        opId: "target",
        kind: "GOAL_SET_TARGET",
        source,
        target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      },
      { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] },
    ], "turn-1"),
    dialogue: emptyDialogueState(),
    workingSet: null,
  };
}

describe("conversation plan policy review", () => {
  it("approves an unchanged policy-compliant semantic plan", () => {
    const plan: TurnPlan = {
      userIntentSummary: "search the current goal",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    };
    const result = reviewConversationPlan({ plan, state: stateWithTargetAndMarket(), searchNeed: "INSUFFICIENT_COVERAGE" });
    expect(result).toMatchObject({ review: { decision: "APPROVED", policyVersion: expect.any(String) } });
    expect("policyDecision" in result && result.policyDecision.plan).toEqual(plan);
  });

  it("requests structured repair instead of executing a legacy semantic rewrite", () => {
    const state = stateWithTargetAndMarket();
    state.goalRevision = createGoalRevision(null, [state.goalRevision!.operations[0]!], "turn-1");
    const plan: TurnPlan = {
      userIntentSummary: "search without a purchase market",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    };
    const before = structuredClone(plan);
    const result = reviewConversationPlan({ plan, state, searchNeed: "INSUFFICIENT_COVERAGE" });
    expect(result).toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{
          code: "SEARCH_MARKETS_REQUIRED",
          operationId: "search",
          path: "ops",
          observed: { operationKinds: ["SEARCH_OFFERS"] },
          admissibleAlternatives: expect.arrayContaining([expect.stringContaining("PURCHASE_MARKET")]),
        }],
      },
    });
    expect(plan).toEqual(before);
  });

  it("turns hard provider authorization failures into typed repair guidance", () => {
    const plan: TurnPlan = {
      userIntentSummary: "search even though current evidence is sufficient",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    };
    const result = reviewConversationPlan({ plan, state: stateWithTargetAndMarket(), searchNeed: "NOT_NEEDED" });
    expect(result).toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{
          code: "UNNECESSARY_PROVIDER_SEARCH",
          operationId: "search",
          path: "ops",
          admissibleAlternatives: expect.arrayContaining([expect.stringContaining("Remove SEARCH_OFFERS")]),
        }],
      },
    });
  });

  it("requests repair when a registered identity qualifier is duplicated as a goal attribute", () => {
    const state = stateWithTargetAndMarket();
    state.goalRevision = createGoalRevision(null, [{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: {
        categoryId: "headphones",
        targetText: "头戴式耳机",
        canonicalModel: null,
        itemRole: "PRIMARY_PRODUCT",
        condition: "ANY",
      },
    }, { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] }], "turn-1");
    const plan: TurnPlan = {
      userIntentSummary: "retain a target identity qualifier once",
      ops: [{
        opId: "duplicate-form-factor",
        kind: "GOAL_UPSERT_CONSTRAINT",
        source,
        constraint: { key: "form_factor", value: "over_ear", operator: "EQ" },
      }],
      leftover: [],
    };
    expect(reviewConversationPlan({ plan, state, searchNeed: "NOT_NEEDED" })).toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{
          code: "TARGET_IDENTITY_ATTRIBUTE_DUPLICATED",
          operationId: "duplicate-form-factor",
          observed: { key: "form_factor", value: "over_ear", targetText: "头戴式耳机" },
        }],
      },
    });
  });

  it("gives a single causal repair when exploratory scope duplicates explicit markets", () => {
    const plan: TurnPlan = {
      userIntentSummary: "search the two explicit markets",
      ops: [{
        opId: "search",
        kind: "SEARCH_OFFERS",
        reasonCode: "INSUFFICIENT_COVERAGE",
        marketScope: ["US", "SG"],
        assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
      }],
      leftover: [],
    };
    const result = reviewConversationPlan({ plan, state: stateWithTargetAndMarket(), searchNeed: "INSUFFICIENT_COVERAGE" });
    expect(result).toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{
          code: "SEARCH_MARKET_SCOPE_REDUNDANT",
          operationId: "search",
          admissibleAlternatives: [expect.stringContaining("Remove marketScope")],
        }],
      },
    });
  });

  it("requires a concrete market question instead of approving a silent half-built initial goal", () => {
    const state: ConversationState = {
      revision: 0,
      status: "OPEN",
      goalRevision: null,
      dialogue: emptyDialogueState(),
      workingSet: null,
    };
    const plan: TurnPlan = {
      userIntentSummary: "start shopping without a purchase market",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          source,
          target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "3000", currency: "CNY" } },
      ],
      leftover: [],
    };
    expect(reviewConversationPlan({ plan, state, searchNeed: "INSUFFICIENT_COVERAGE" })).toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{
          code: "PURCHASE_MARKET_CLARIFICATION_REQUIRED",
          operationId: null,
          admissibleAlternatives: [expect.stringContaining("PURCHASE_MARKET")],
        }],
      },
    });
  });

  it("rejects candidate inspection when the projected candidate set is empty", () => {
    const state = stateWithTargetAndMarket();
    state.workingSet = createWorkingSet({ version: 1, boundGoalVersion: state.goalRevision!.version, pool: [] });
    const plan: TurnPlan = {
      userIntentSummary: "compare unavailable candidates",
      ops: [{
        opId: "inspect",
        kind: "INSPECT_WORKING_SET",
        referents: [{ kind: "DISPLAY_RANK", rank: 1 }, { kind: "DISPLAY_RANK", rank: 2 }],
        fields: ["PRICE"],
      }],
      leftover: [],
    };
    expect(reviewConversationPlan({ plan, state, searchNeed: "INSUFFICIENT_COVERAGE" })).toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{ code: "CANDIDATE_SET_REQUIRED", operationId: null }],
      },
    });
  });
});
