import { describe, expect, it } from "vitest";

import {
  candidateFeedbackForTurn,
  createWorkingSet,
  emptyShoppingGoal,
  reprojectWorkingSetForGoal,
  type CandidateProjection,
  type TurnPlan,
} from "../src/index.js";

function candidate(offerRef: string, title: string): CandidateProjection {
  return {
    offerRef,
    title,
    canonicalModel: null,
    categoryId: "laptop",
    itemRole: "PRIMARY_PRODUCT",
    condition: "UNKNOWN",
    retrievalMarket: "US",
    merchant: "Merchant",
    cnyAmount: "5000",
    stock: "UNKNOWN",
    claimIds: [],
    discovery: {
      supportLevel: "DISCOVERY",
      identityLevel: "OFFER_ONLY",
      identityKey: null,
      matchedPreferenceKeys: [],
      contradictedPreferenceKeys: [],
      rankVector: { eligibilityTier: 2, targetCoverage: 1, positiveCoverage: 0, negativeConflicts: 0, evidenceTier: 2, stockTier: 1, priceTieBreaker: "5000" },
    },
  };
}

describe("candidate feedback and preference projection", () => {
  it("derives append-only feedback from the validated turn plan", () => {
    const workingSet = createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [candidate("a", "Lightweight Laptop"), candidate("b", "Gaming Laptop")] });
    const plan: TurnPlan = {
      userIntentSummary: "research and refine",
      leftover: [],
      ops: [
        { opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "USER_REQUESTED" },
        { opId: "focus", kind: "SET_FOCUS", referent: { kind: "OFFER_REF", offerRef: "a" } },
        { opId: "compare", kind: "SET_COMPARISON", referents: [{ kind: "OFFER_REF", offerRef: "a" }, { kind: "OFFER_REF", offerRef: "b" }] },
        { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "OFFER_REF", offerRef: "b" }], reasonCode: "USER_REJECTED" },
        { opId: "restore", kind: "RESTORE_OFFERS", referents: [{ kind: "OFFER_REF", offerRef: "b" }] },
        { opId: "prefer", kind: "GOAL_UPSERT_PREFERENCE", source: { messageId: "m1" }, preference: { key: "portable", value: "lightweight", weight: 2 } },
      ],
    };
    expect(candidateFeedbackForTurn(plan, workingSet)).toMatchObject([
      { kind: "IMPRESSION", operationId: "research", offerRefs: ["a", "b"] },
      { kind: "FOCUS", operationId: "focus", offerRefs: ["a"] },
      { kind: "COMPARE", operationId: "compare", offerRefs: ["a", "b"] },
      { kind: "REJECT", operationId: "reject", offerRefs: ["b"] },
      { kind: "RESTORE", operationId: "restore", offerRefs: ["b"] },
      { kind: "CRITIQUE", operationId: "prefer", offerRefs: [], payload: { preference: { key: "portable", value: "lightweight", weight: 2 } } },
    ]);
  });

  it("reranks an existing Discovery set from session preferences without mutating its proof pool", () => {
    const set = createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [candidate("gaming", "Gaming Laptop 16"), candidate("light", "Lightweight Laptop 14")] });
    const originalPool = structuredClone(set.pool);
    const goal = {
      ...emptyShoppingGoal(),
      target: { categoryId: "laptop", targetText: "laptop", canonicalModel: null, itemRole: "PRIMARY_PRODUCT" as const, condition: "ANY" as const },
      retrievalMarkets: ["US"],
      preferences: [{ key: "portable", value: "lightweight", weight: 2, source: { messageId: "m1" } }],
    };
    const projected = reprojectWorkingSetForGoal(set, goal);
    expect(projected.displayOfferRefs).toEqual(["light", "gaming"]);
    expect(projected.pool).toEqual(originalPool);
  });
});
