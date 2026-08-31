import {
  emptyDialogueState,
  evaluateConversationPolicy,
  resolveCategoryValidationCapability,
  type ConversationState,
  type SearchGoalSnapshot,
  type TurnPlan,
} from "@interec/domain";
import { describe, expect, it } from "vitest";

import { buildSearchProvenanceBundle, runOfferSearchBatch } from "../src/index.js";

describe("unregistered third-category acceptance", () => {
  it("searches washing machines without a budget or category validation policy and returns source-grounded results", async () => {
    expect(resolveCategoryValidationCapability("washing_machine", "front load washing machine")).toEqual({
      validationMode: "SEARCH_ONLY",
      categoryId: "washing_machine",
      queryTerm: "front load washing machine",
      policy: null,
    });
    const initialState: ConversationState = {
      revision: 0,
      status: "OPEN",
      goalRevision: null,
      dialogue: emptyDialogueState(),
      workingSet: null,
    };
    const source = { messageId: "washing-request" };
    const plan: TurnPlan = {
      userIntentSummary: "find a front-load washing machine in the US",
      leftover: [],
      ops: [
        { opId: "target", kind: "GOAL_SET_TARGET", source, target: { categoryId: "washing_machine", targetText: "front load washing machine", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "GOAL_BECAME_SEARCH_READY" },
      ],
    };
    const policy = evaluateConversationPolicy({ plan, state: initialState, searchNeed: "INSUFFICIENT_COVERAGE" });
    expect(policy.plan).toEqual(plan);
    expect(policy.projectedGoal.budget).toBeNull();

    const goal: SearchGoalSnapshot = {
      query: "front load washing machine",
      target: { categoryId: "washing_machine", targetText: "front load washing machine", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" },
      markets: ["US"],
      budgetCny: null,
      stockPreference: "ANY",
      excludedOfferRefs: [],
    };
    const product = {
      id: "washer-1",
      title: "Front Load Washing Machine 10kg",
      price: { amount: "699", currency: "USD" },
      merchant: "Appliance Merchant",
      url: "https://appliances.us/washer-1",
      country_code: "US",
      category_path: ["Home Appliances", "Washing Machines"],
      metadata: { product_type: "Front Load Washer" },
    };
    const payload = { data: [product] };
    const batch = await runOfferSearchBatch(goal, [goal.query], {
      search: async (_query, market) => ({ market, products: [product], artifactRef: "sha256:washing-machine", rawPayload: payload, observedAt: "2026-08-27T00:00:00.000Z" }),
    }, {
      getRate: async (base) => ({ id: "fx-washer", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-27T00:00:00.000Z", expiresAt: "2026-08-28T00:00:00.000Z" }),
    });
    const provenance = buildSearchProvenanceBundle({
      rankedOfferSet: batch.rankedOfferSet,
      artifacts: batch.artifacts,
      coverage: batch.coverage,
      workingSetVersion: 1,
      boundGoalVersion: 1,
    });
    expect(batch.rankedOfferSet.eligibilityResults[0]).toMatchObject({
      status: "DISCOVERABLE",
      offer: { validationMode: "SEARCH_ONLY", targetCategoryId: "washing_machine", productIdentity: { status: "UNRESOLVED", comparisonKey: null } },
    });
    expect(provenance.workingSet.pool[0]).toMatchObject({
      categoryId: "washing_machine",
      ranking: { validationMode: "SEARCH_ONLY", identityResolution: "LISTING_LEVEL", identityKey: null },
    });
    expect(provenance.claims.map((claim) => claim.kind)).toEqual(expect.arrayContaining(["PRICE", "MERCHANT", "MARKET"]));
  });

  it("uses rule validation for categories with a registered policy", () => {
    expect(resolveCategoryValidationCapability("headphones")).toMatchObject({ validationMode: "RULE_VALIDATED", categoryId: "headphones", policy: { version: "2026-08-01" } });
    expect(resolveCategoryValidationCapability("smartphone")).toMatchObject({ validationMode: "RULE_VALIDATED", categoryId: "smartphone" });
  });
});
