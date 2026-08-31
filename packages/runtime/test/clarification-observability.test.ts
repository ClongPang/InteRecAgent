import { describe, expect, it } from "vitest";

import { emptyShoppingGoal } from "@interec/domain";
import { clarificationResolutionOutcome, goalRetentionChecks } from "../src/clarification-observability.js";

const goal = {
  ...emptyShoppingGoal(),
  target: {
    categoryId: "headphones",
    targetText: "over-ear headphones",
    canonicalModel: null,
    itemRole: "PRIMARY_PRODUCT" as const,
    condition: "ANY" as const,
  },
  budget: { amount: "3000", currency: "CNY" },
  retrievalMarkets: ["US"],
};

describe("clarification observability", () => {
  it("checks only fields that the answered clarification was not expected to change", () => {
    expect(goalRetentionChecks(goal, { ...goal, retrievalMarkets: ["SG", "US"] }, "PURCHASE_MARKET")).toEqual([
      { field: "TARGET", retained: true },
      { field: "BUDGET", retained: true },
    ]);
    expect(goalRetentionChecks(goal, { ...goal, target: { ...goal.target!, targetText: "earbuds" } }, "TARGET_PRODUCT")).toEqual([
      { field: "BUDGET", retained: true },
      { field: "RETRIEVAL_MARKETS", retained: true },
    ]);
  });

  it("reports semantic field loss independently of object key ordering", () => {
    expect(goalRetentionChecks(goal, { ...goal, budget: null }, "PURCHASE_MARKET")).toEqual([
      { field: "TARGET", retained: true },
      { field: "BUDGET", retained: false },
    ]);
  });

  it("classifies resolved, repeated, chained and degraded answers", () => {
    expect(clarificationResolutionOutcome("PURCHASE_MARKET", null, false)).toBe("RESOLVED");
    expect(clarificationResolutionOutcome("PURCHASE_MARKET", "PURCHASE_MARKET", false)).toBe("REPEATED");
    expect(clarificationResolutionOutcome("PURCHASE_MARKET", "BUDGET", false)).toBe("RESOLVED_WITH_NEXT_CLARIFICATION");
    expect(clarificationResolutionOutcome("PURCHASE_MARKET", null, true)).toBe("DEGRADED");
  });
});
