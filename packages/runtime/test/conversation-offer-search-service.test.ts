import type { SearchGoalSnapshot } from "@interec/domain";
import { describe, expect, it } from "vitest";

import { ConversationOfferSearchService, queryVariants, toSearchGoal } from "../src/conversation-offer-search-service.js";

const categoryGoal: SearchGoalSnapshot = {
  query: "headphones active noise cancelling",
  target: {
    categoryId: "headphones",
    canonicalModel: null,
    itemRole: "PRIMARY_PRODUCT",
    conditionPreference: "ANY",
  },
  markets: ["US", "SG"],
  budgetCny: "2500",
  stockPreference: "ANY",
  excludedOfferRefs: [],
  hardConstraints: [{ key: "noise_cancelling", operator: "EQ", value: true }],
};

describe("offer-search query compilation", () => {
  it("uses a policy-owned exploratory market scope without persisting it as a user goal", () => {
    const state = {
      revision: 2,
      status: "OPEN",
      goalRevision: {
        version: 1,
        parentVersion: null,
        committedByTurnId: "turn-1",
        operations: [],
        goal: {
          target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
          budget: { amount: "3000", currency: "CNY" },
          retrievalMarkets: [],
          deliveryDestination: null,
          stockPreference: "ANY",
          hardConstraints: [],
          preferences: [],
          exclusions: [],
          unresolved: [],
        },
      },
      dialogue: { pendingClarification: null, clarificationHistory: [], pendingOps: [], focusOfferRef: null, comparisonOfferRefs: [], lastAssistantMessageId: null },
      workingSet: null,
    } as const;
    expect(toSearchGoal(state, ["US", "SG"])).toMatchObject({ markets: ["US", "SG"], budgetCny: "3000" });
    expect(state.goalRevision.goal.retrievalMarkets).toEqual([]);
  });

  it("turns a published historical attempt failure into a mandatory non-absence disclosure", async () => {
    const researchRepository = {
      pool: {},
      loadLatestPublishedSearchCoverage: async () => ({
        turnId: "prior-turn",
        attempt: 1,
        attemptNo: 2,
        status: "PARTIAL",
        completedAt: "2026-08-29T00:00:00.000Z",
        publishedRevision: 3,
        coverage: {
          requestedMarkets: ["US", "SG"],
          completedMarkets: ["US"],
          failedMarkets: ["SG"],
          discoveredCount: 3,
          comparableCount: 3,
          ineligibleCount: 0,
          insufficientEvidenceCount: 0,
          rejectionReasonCounts: {},
          topReasonCode: null,
          stopReason: "COVERAGE_SATISFIED",
          adequate: true,
        },
        marketOutcomes: [
          { market: "SG", status: "FAILED", resultCount: 0 },
          { market: "US", status: "COMPLETED", resultCount: 3 },
        ],
      }),
    };
    const shoppingData = new ConversationOfferSearchService(
      { owner: { tenantId: "tenant", ownerId: "owner" }, conversationId: "conversation" } as never,
      {} as never,
      researchRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await shoppingData.inspectSearchCoverage(
      { opId: "coverage", kind: "INSPECT_SEARCH_COVERAGE" },
      {} as never,
    );
    expect(result.claims).toEqual([]);
    expect(result.disclosureCodes).toEqual(["SEARCH_COVERAGE_INCOMPLETE:SG"]);
    expect(result.publicResult).toMatchObject({
      found: true,
      interpretation: "INCOMPLETE_COVERAGE_DOES_NOT_PROVE_MARKET_ABSENCE",
      coverage: { failedMarkets: ["SG"], completedMarkets: ["US"] },
    });
  });

  it("carries supported hard constraints into every provider query variant", () => {
    expect(queryVariants({
      opId: "search",
      kind: "SEARCH_OFFERS",
      reasonCode: "USER_REQUESTED",
      queryVariant: "commute headphones",
    }, categoryGoal)).toEqual([
      "headphones active noise cancelling",
      "commute headphones active noise cancelling",
    ]);
  });

  it("does not invent query terms when the goal has no matching hard constraint", () => {
    expect(queryVariants({
      opId: "search",
      kind: "SEARCH_OFFERS",
      reasonCode: "USER_REQUESTED",
    }, { ...categoryGoal, query: "headphones", hardConstraints: [] })).toEqual(["headphones"]);
  });

  it("compiles an open-category target without a registered validation policy", () => {
    const openGoal: SearchGoalSnapshot = {
      ...categoryGoal,
      query: "lightweight laptop",
      target: { categoryId: "laptop", targetText: "轻薄笔记本", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" },
      hardConstraints: [],
    };
    expect(queryVariants({
      opId: "search-open",
      kind: "SEARCH_OFFERS",
      reasonCode: "USER_REQUESTED",
      queryVariant: "travel notebook",
    }, openGoal)).toEqual(["lightweight laptop", "travel notebook", "轻薄笔记本 laptop"]);
  });
});
