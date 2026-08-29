import type { Goal } from "@interec/domain";
import { describe, expect, it } from "vitest";

import { ConversationResearchWorld, queryVariants } from "../src/conversation-research-world.js";

const categoryGoal: Goal = {
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

describe("research query compilation", () => {
  it("turns a promoted historical wave failure into a mandatory non-absence disclosure", async () => {
    const researchRepository = {
      pool: {},
      loadLatestPromotedResearchCoverage: async () => ({
        turnId: "prior-turn",
        attempt: 1,
        waveNo: 2,
        status: "PARTIAL",
        completedAt: "2026-08-29T00:00:00.000Z",
        promotedRevision: 3,
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
    const world = new ConversationResearchWorld(
      { owner: { tenantId: "tenant", ownerId: "owner" }, conversationId: "conversation" } as never,
      {} as never,
      researchRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await world.inspectResearchCoverage(
      { opId: "coverage", kind: "INSPECT_RESEARCH_COVERAGE" },
      {} as never,
    );
    expect(result.claims).toEqual([]);
    expect(result.disclosureCodes).toEqual(["RESEARCH_COVERAGE_INCOMPLETE:SG"]);
    expect(result.publicResult).toMatchObject({
      found: true,
      interpretation: "INCOMPLETE_COVERAGE_DOES_NOT_PROVE_MARKET_ABSENCE",
      coverage: { failedMarkets: ["SG"], completedMarkets: ["US"] },
    });
  });

  it("carries supported hard constraints into every provider query variant", () => {
    expect(queryVariants({
      opId: "research",
      kind: "RESEARCH_OFFERS",
      reasonCode: "USER_REQUESTED",
      queryVariant: "commute headphones",
    }, categoryGoal)).toEqual([
      "headphones active noise cancelling",
      "commute headphones active noise cancelling",
    ]);
  });

  it("does not invent query terms when the goal has no matching hard constraint", () => {
    expect(queryVariants({
      opId: "research",
      kind: "RESEARCH_OFFERS",
      reasonCode: "USER_REQUESTED",
    }, { ...categoryGoal, query: "headphones", hardConstraints: [] })).toEqual(["headphones"]);
  });

  it("compiles an open-category target without a registered adapter", () => {
    const openGoal: Goal = {
      ...categoryGoal,
      query: "lightweight laptop",
      target: { categoryId: "laptop", targetText: "轻薄笔记本", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" },
      hardConstraints: [],
    };
    expect(queryVariants({
      opId: "research-open",
      kind: "RESEARCH_OFFERS",
      reasonCode: "USER_REQUESTED",
      queryVariant: "travel notebook",
    }, openGoal)).toEqual(["lightweight laptop", "travel notebook", "轻薄笔记本 laptop"]);
  });
});
