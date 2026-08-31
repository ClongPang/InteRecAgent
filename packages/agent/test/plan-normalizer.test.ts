import { describe, expect, it } from "vitest";

import { createGoalRevision, type ConversationState } from "@interec/domain";

import { normalizeTurnPlanProposal } from "../src/plan-normalizer.js";

function emptyState(): ConversationState {
  return {
    revision: 0,
    status: "OPEN",
    goalRevision: null,
    dialogue: {
      pendingClarification: null,
      pendingOps: [],
      focusOfferRef: null,
      comparisonOfferRefs: [],
      lastAssistantMessageId: null,
    },
    workingSet: null,
  };
}

describe("turn plan normalizer", () => {
  it("canonicalizes redundant exploratory scope when explicit markets already exist", () => {
    const state = emptyState();
    state.goalRevision = createGoalRevision(null, [{
      opId: "market",
      kind: "GOAL_SET_RETRIEVAL_MARKETS",
      source: { messageId: "message" },
      markets: ["US"],
    }], "turn");
    const normalized = normalizeTurnPlanProposal({
      userIntentSummary: "search the already selected market",
      ops: [{
        opId: "search",
        kind: "SEARCH_OFFERS",
        reasonCode: "GOAL_BECAME_SEARCH_READY",
        marketScope: ["US", "SG"],
        assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED", "PRODUCT_CONDITION_NOT_RESTRICTED"],
      }],
      leftover: [],
    }, state);
    expect(normalized.ops).toEqual([expect.objectContaining({
      kind: "SEARCH_OFFERS",
      assumptionDisclosureCodes: ["PRODUCT_CONDITION_NOT_RESTRICTED"],
    })]);
    expect(normalized.ops[0]).not.toHaveProperty("marketScope");
  });

  it("uses message provenance, not user wording, to resolve superseding singleton effects", () => {
    const compiled = normalizeTurnPlanProposal({
      userIntentSummary: "scope correction",
      ops: [
        { opId: "old", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US", "SG"] },
        { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["SG"] },
      ],
      leftover: [],
    }, emptyState());
    expect(compiled.ops).toEqual([
      { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["SG"] },
    ]);
  });

  it("is invariant to summaries and operation array order when source provenance is unchanged", () => {
    const proposals = [
      {
        userIntentSummary: "please narrow the scope",
        ops: [
          { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 1, markets: ["SG"] },
          { opId: "old", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 0, markets: ["US", "SG"] },
        ],
        leftover: [],
      },
      {
        userIntentSummary: "用户调整了检索范围",
        ops: [
          { opId: "old", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 0, markets: ["US", "SG"] },
          { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 1, markets: ["SG"] },
        ],
        leftover: [],
      },
    ];
    for (const proposal of proposals) {
      expect(normalizeTurnPlanProposal(proposal, emptyState()).ops).toEqual([
        { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["SG"] },
      ]);
    }
  });

  it("keeps independent semantic effects from the same message", () => {
    const compiled = normalizeTurnPlanProposal({
      userIntentSummary: "compound change",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3000", currency: "CNY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] },
      ],
      leftover: [],
    }, emptyState());
    expect(compiled.ops.map((operation) => operation.kind)).toEqual(["GOAL_SET_BUDGET", "GOAL_SET_RETRIEVAL_MARKETS"]);
  });

  it("removes unchanged collection upserts so prior evidence provenance remains stable", () => {
    const state = emptyState();
    state.goalRevision = createGoalRevision(null, [
      {
        opId: "preference-old",
        kind: "GOAL_UPSERT_PREFERENCE",
        source: { messageId: "original-message" },
        preference: { key: "use_case", value: "提高家务效率", weight: 0.8 },
      },
      {
        opId: "constraint-old",
        kind: "GOAL_UPSERT_CONSTRAINT",
        source: { messageId: "original-message" },
        constraint: { key: "noise_cancelling", operator: "EQ", value: true },
      },
    ], "original-turn");
    const normalized = normalizeTurnPlanProposal({
      userIntentSummary: "continue the existing goal",
      ops: [
        {
          opId: "preference-repeat",
          kind: "GOAL_UPSERT_PREFERENCE",
          sourceMessageOrdinal: 0,
          preference: { key: "use_case", value: "提高家务效率", weight: 0.8 },
        },
        {
          opId: "constraint-repeat",
          kind: "GOAL_UPSERT_CONSTRAINT",
          sourceMessageOrdinal: 0,
          constraint: { key: "noise_cancelling", operator: "EQ", value: true },
        },
      ],
      leftover: [],
    }, state);
    expect(normalized.ops).toEqual([]);
  });

  it("derives mechanical price reranking without parsing prose", () => {
    const state = emptyState();
    state.workingSet = {
      version: 1,
      boundGoalVersion: 1,
      pool: [],
      displayOfferRefs: [],
      mentionedOfferRefs: [],
      comparisonOfferRefs: [],
      rejectedOfferRefs: [],
      focusOfferRef: null,
    };
    const compiled = normalizeTurnPlanProposal({
      userIntentSummary: "prefer lower price",
      ops: [{
        opId: "preference",
        kind: "GOAL_UPSERT_PREFERENCE",
        sourceMessageOrdinal: 0,
        preference: { key: "price", value: "LOWER", weight: 1 },
      }],
      leftover: [],
    }, state);
    expect(compiled.ops.map((operation) => operation.kind)).toEqual(["GOAL_UPSERT_PREFERENCE", "SORT_WORKING_SET_BY_PRICE"]);
  });
});
