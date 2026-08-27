import {
  emptyDialogueState,
  evaluateConversationPolicy,
  resolveCategoryRecommendationCapability,
  type ConversationState,
  type Goal,
  type TurnPlan,
} from "@interec/domain";
import { describe, expect, it } from "vitest";

import { buildResearchProofBundle, runResearchCampaign } from "../src/index.js";

describe("unregistered third-category acceptance", () => {
  it("researches washing machines without budget or a category adapter and returns Discovery evidence", async () => {
    expect(resolveCategoryRecommendationCapability("washing_machine", "front load washing machine")).toEqual({
      supportLevel: "DISCOVERY",
      categoryId: "washing_machine",
      queryTerm: "front load washing machine",
      adapter: null,
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
      ],
    };
    const policy = evaluateConversationPolicy({ plan, state: initialState, researchNeed: "INSUFFICIENT_COVERAGE" });
    expect(policy.plan.ops.at(-1)).toMatchObject({ kind: "RESEARCH_OFFERS", reasonCode: "GOAL_BECAME_RESEARCH_READY" });
    expect(policy.projectedGoal.budget).toBeNull();

    const goal: Goal = {
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
    const campaign = await runResearchCampaign(goal, [goal.query], {
      search: async (_query, market) => ({ market, products: [product], artifactRef: "sha256:washing-machine", rawPayload: payload, observedAt: "2026-08-27T00:00:00.000Z" }),
    }, {
      getRate: async (base) => ({ id: "fx-washer", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-27T00:00:00.000Z", expiresAt: "2026-08-28T00:00:00.000Z" }),
    });
    const proof = buildResearchProofBundle({
      comparisonSet: campaign.comparisonSet,
      artifacts: campaign.artifacts,
      coverage: campaign.coverage,
      workingSetVersion: 1,
      boundGoalVersion: 1,
    });
    expect(campaign.comparisonSet.qualifications[0]).toMatchObject({
      status: "DISCOVERABLE",
      offer: { supportLevel: "DISCOVERY", targetCategoryId: "washing_machine", productIdentity: { status: "UNRESOLVED", comparisonKey: null } },
    });
    expect(proof.workingSet.pool[0]).toMatchObject({
      categoryId: "washing_machine",
      discovery: { supportLevel: "DISCOVERY", identityLevel: "OFFER_ONLY", identityKey: null },
    });
    expect(proof.claims.map((claim) => claim.kind)).toEqual(expect.arrayContaining(["PRICE", "MERCHANT", "MARKET"]));
  });

  it("keeps registered adapters on the Verified path", () => {
    expect(resolveCategoryRecommendationCapability("headphones")).toMatchObject({ supportLevel: "VERIFIED", categoryId: "headphones", adapter: { contractVersion: "2026-08-01" } });
    expect(resolveCategoryRecommendationCapability("smartphone")).toMatchObject({ supportLevel: "VERIFIED", categoryId: "smartphone" });
  });
});
