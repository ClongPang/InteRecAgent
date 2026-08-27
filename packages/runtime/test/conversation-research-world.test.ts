import type { Goal } from "@interec/domain";
import { describe, expect, it } from "vitest";

import { queryVariants } from "../src/conversation-research-world.js";

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
