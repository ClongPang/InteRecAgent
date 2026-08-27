import { describe, expect, it } from "vitest";

import {
  applyGoalOperations,
  bindCandidateReferent,
  canonicalDiscoveryCategory,
  createGoalRevision,
  createWorkingSet,
  emptyShoppingGoal,
  exactPreviousGoalRevision,
  refilterWorkingSetByMarkets,
  reprojectWorkingSetForGoal,
  rejectWorkingSetOffers,
  renderAssistantEnvelope,
  rerankWorkingSetByPrice,
  resolveReferents,
  restoreWorkingSetOffers,
  routeForTurnPlan,
  setWorkingSetComparison,
  setWorkingSetFocus,
  supportLevelForCategory,
  validateAssistantEnvelope,
  validateTurnPlan,
  type AssistantEnvelope,
  type CandidateProjection,
  type ClaimLedger,
  type GoalOperation,
  type TurnPlan,
} from "../src/index.js";

const source = { messageId: "message-1" };

function candidate(overrides: Partial<CandidateProjection> = {}): CandidateProjection {
  return {
    offerRef: "offer-1",
    title: "Sony WH-1000XM5 Black",
    canonicalModel: "WH-1000XM5",
    categoryId: "headphones",
    itemRole: "PRIMARY_PRODUCT",
    condition: "NEW",
    retrievalMarket: "US",
    merchant: "Merchant A",
    cnyAmount: "2100.00",
    stock: "UNKNOWN",
    claimIds: ["claim-price-1"],
    ...overrides,
  };
}

describe("shopping goal revisions", () => {
  it("applies ordered operations and treats correction as replacement", () => {
    const operations: GoalOperation[] = [
      { opId: "target-xm5", kind: "GOAL_SET_TARGET", source, target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
      { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "2500.00", currency: "cny" } },
      { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["sg", "US", "SG"] },
      { opId: "target-xm4", kind: "GOAL_SET_TARGET", source, target: { categoryId: "headphones", canonicalModel: "WH-1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
    ];
    const goal = applyGoalOperations(emptyShoppingGoal(), operations);
    expect(goal.target?.canonicalModel).toBe("WH-1000XM4");
    expect(goal.budget).toEqual({ amount: "2500", currency: "CNY" });
    expect(goal.retrievalMarkets).toEqual(["SG", "US"]);
    expect(goal.exclusions).toEqual([]);
  });

  it("keeps retrieval scope distinct from delivery destination", () => {
    const goal = applyGoalOperations(emptyShoppingGoal(), [
      { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US", "SG"] },
      { opId: "destination", kind: "GOAL_SET_DELIVERY_DESTINATION", source, destination: "CN" },
    ]);
    expect(goal.retrievalMarkets).toEqual(["SG", "US"]);
    expect(goal.deliveryDestination).toBe("CN");
  });

  it("canonicalizes registered categories while retaining open discovery categories", () => {
    const goal = applyGoalOperations(emptyShoppingGoal(), [{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "wireless_noise_cancelling_headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
    }]);
    expect(goal.target?.categoryId).toBe("headphones");
    const discovery = applyGoalOperations(emptyShoppingGoal(), [{
      opId: "unsupported",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "washing machine", targetText: "washing machine", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
    }]);
    expect(discovery.target).toMatchObject({ categoryId: "washing_machine", targetText: "washing machine" });
    expect(supportLevelForCategory(discovery.target!.categoryId)).toBe("DISCOVERY");
    expect(supportLevelForCategory("headphones")).toBe("VERIFIED");
    expect(canonicalDiscoveryCategory("wireless/noise cancelling headphones")).toBe("headphones");
  });

  it("upserts constraints and preferences instead of accumulating conflicting copies", () => {
    const goal = applyGoalOperations(emptyShoppingGoal(), [
      { opId: "c1", kind: "GOAL_UPSERT_CONSTRAINT", source, constraint: { key: "color", operator: "EQ", value: "black" } },
      { opId: "c2", kind: "GOAL_UPSERT_CONSTRAINT", source, constraint: { key: "color", operator: "EQ", value: "silver" } },
      { opId: "p1", kind: "GOAL_UPSERT_PREFERENCE", source, preference: { key: "price", value: "lower", weight: 0.8 } },
    ]);
    expect(goal.hardConstraints).toHaveLength(1);
    expect(goal.hardConstraints[0]?.value).toBe("silver");
    expect(goal.preferences).toMatchObject([{ key: "price", value: "lower", weight: 0.8 }]);
  });

  it("restores the exact parent revision for undo", () => {
    const first = createGoalRevision(null, [{ opId: "b1", kind: "GOAL_SET_BUDGET", source, budget: { amount: "2500", currency: "CNY" } }], "turn-1");
    const second = createGoalRevision(first, [{ opId: "b2", kind: "GOAL_SET_BUDGET", source, budget: { amount: "3000", currency: "CNY" } }], "turn-2");
    expect(exactPreviousGoalRevision([first, second], second.version)).toEqual(first);
  });

  it("rejects duplicate operations and non-positive budgets", () => {
    expect(() => applyGoalOperations(emptyShoppingGoal(), [
      { opId: "same", kind: "GOAL_CLEAR_BUDGET", source },
      { opId: "same", kind: "GOAL_CLEAR_TARGET", source },
    ])).toThrowError(/same/);
    expect(() => applyGoalOperations(emptyShoppingGoal(), [
      { opId: "zero", kind: "GOAL_SET_BUDGET", source, budget: { amount: "0", currency: "CNY" } },
    ])).toThrowError(/positive/i);
  });
});

describe("working set as the referential world", () => {
  const pool = [
    candidate(),
    candidate({ offerRef: "offer-2", title: "Sony WH-1000XM5 Silver", merchant: "Merchant B", retrievalMarket: "SG", cnyAmount: "1900.00", claimIds: ["claim-price-2"] }),
    candidate({ offerRef: "offer-3", title: "Bose QuietComfort Black", canonicalModel: "QuietComfort", merchant: "Merchant C", cnyAmount: "2300.00", claimIds: ["claim-price-3"] }),
  ];

  it("binds display rank and focus without falling back to rank one", () => {
    let set = createWorkingSet({ version: 1, boundGoalVersion: 1, pool });
    expect(bindCandidateReferent(set, { kind: "DISPLAY_RANK", rank: 2 })).toEqual({ status: "RESOLVED", offerRefs: ["offer-2"] });
    expect(bindCandidateReferent(set, { kind: "DISPLAY_RANK", rank: 9 })).toEqual({ status: "NOT_FOUND", offerRefs: [] });
    set = setWorkingSetFocus(set, "offer-3");
    expect(bindCandidateReferent(set, { kind: "FOCUS" })).toEqual({ status: "RESOLVED", offerRefs: ["offer-3"] });
  });

  it("returns ambiguity for an open noun instead of choosing the first Sony", () => {
    const set = createWorkingSet({ version: 1, boundGoalVersion: 1, pool });
    expect(bindCandidateReferent(set, { kind: "TEXT", text: "Sony" })).toEqual({ status: "AMBIGUOUS", offerRefs: ["offer-1", "offer-2"] });
    expect(() => resolveReferents(set, [{ kind: "TEXT", text: "Sony" }])).toThrowError(/offer-1,offer-2/);
  });

  it("rejects, restores, compares and mentions only known offers", () => {
    let set = createWorkingSet({ version: 1, boundGoalVersion: 1, pool });
    set = setWorkingSetComparison(set, ["offer-1", "offer-2"]);
    expect(set.mentionedOfferRefs).toEqual(["offer-1", "offer-2"]);
    set = rejectWorkingSetOffers(set, ["offer-2"]);
    expect(set.displayOfferRefs).toEqual(["offer-1", "offer-3"]);
    expect(set.comparisonOfferRefs).toEqual([]);
    expect(() => setWorkingSetFocus(set, "offer-2")).toThrowError(/Rejected offer/);
    set = restoreWorkingSetOffers(set, ["offer-2"]);
    expect(set.displayOfferRefs).toEqual(["offer-1", "offer-3", "offer-2"]);
    expect(() => setWorkingSetComparison(set, ["offer-1", "missing"])).toThrowError(/missing/);
  });

  it("refilters and reranks display without destroying the pool", () => {
    const base = createWorkingSet({ version: 1, boundGoalVersion: 1, pool });
    const market = refilterWorkingSetByMarkets(base, ["SG"]);
    expect(market.displayOfferRefs).toEqual(["offer-2"]);
    expect(market.pool).toEqual(base.pool);
    const cheaper = rerankWorkingSetByPrice(base);
    expect(cheaper.displayOfferRefs).toEqual(["offer-2", "offer-1", "offer-3"]);
    expect(cheaper.pool).toEqual(base.pool);
  });

  it("reprojects the visible working set when durable Goal scope narrows", () => {
    const base = setWorkingSetFocus(setWorkingSetComparison(
      createWorkingSet({ version: 1, boundGoalVersion: 1, pool }),
      ["offer-1", "offer-2"],
    ), "offer-1");
    const projected = reprojectWorkingSetForGoal(base, {
      ...emptyShoppingGoal(),
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      retrievalMarkets: ["SG"],
      budget: { amount: "2000", currency: "CNY" },
    });
    expect(projected.displayOfferRefs).toEqual(["offer-2"]);
    expect(projected.pool).toEqual(base.pool);
    expect(projected.comparisonOfferRefs).toEqual([]);
    expect(projected.focusOfferRef).toBeNull();
  });

  it("keeps open-category candidates whose product role is unknown", () => {
    const discovery = candidate({
      offerRef: "washer-1",
      title: "10kg front-load washing machine",
      canonicalModel: null,
      categoryId: "washing_machine",
      itemRole: "UNKNOWN",
      condition: "UNKNOWN",
    });
    const projected = reprojectWorkingSetForGoal(
      createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [discovery] }),
      {
        ...emptyShoppingGoal(),
        target: {
          categoryId: "washing_machine",
          targetText: "front-load washing machine",
          canonicalModel: null,
          itemRole: "PRIMARY_PRODUCT",
          condition: "ANY",
        },
        retrievalMarkets: ["US"],
        preferences: [{ key: "noise_level", value: "low", weight: 0.7, source }],
      },
    );
    expect(projected.displayOfferRefs).toEqual(["washer-1"]);
  });
});

describe("ordered turn plan", () => {
  const compound: TurnPlan = {
    userIntentSummary: "reject the second offer, prefer cheaper options, then inspect the third",
    ops: [
      { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
      { opId: "stance", kind: "RERANK_WORKING_SET", preferenceKey: "price:lower" },
      { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 3 }], fields: ["PRICE"] },
    ],
    leftover: [],
  };

  it("preserves compound operation order and derives the execution route", () => {
    const validated = validateTurnPlan(compound);
    expect(validated.ops.map((item) => item.opId)).toEqual(["reject", "stance", "inspect"]);
    expect(routeForTurnPlan(validated)).toBe("refilter");
  });

  it("prioritizes clarification and research execution classes", () => {
    expect(routeForTurnPlan({ userIntentSummary: "ask budget", ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", slotId: "budget", reasonCode: "HIGH_IMPACT_GAP" }], leftover: [] })).toBe("clarify");
    expect(routeForTurnPlan({ userIntentSummary: "new model", ops: [{ opId: "search", kind: "RESEARCH_OFFERS", reasonCode: "TARGET_CHANGED" }], leftover: [] })).toBe("research");
  });

  it("rejects duplicate ids, multiple research operations, and undo mixed with goal mutation", () => {
    expect(() => validateTurnPlan({ ...compound, ops: [compound.ops[0]!, { ...compound.ops[1]!, opId: "reject" }] })).toThrowError(/reject/);
    expect(() => validateTurnPlan({ userIntentSummary: "search twice", ops: [
      { opId: "r1", kind: "RESEARCH_OFFERS", reasonCode: "A" },
      { opId: "r2", kind: "RESEARCH_OFFERS", reasonCode: "B" },
    ], leftover: [] })).toThrowError(/research/i);
    expect(() => validateTurnPlan({ userIntentSummary: "undo and patch", ops: [
      { opId: "undo", kind: "UNDO_REVISION", revision: 1 },
      { opId: "budget", kind: "GOAL_CLEAR_BUDGET", source },
    ], leftover: [] })).toThrowError(/Undo and goal mutation/);
  });
});

describe("assistant envelope and claim ledger", () => {
  const plan: TurnPlan = {
    userIntentSummary: "explain the selected offer",
    ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "OFFER_REF", offerRef: "offer-1" }], fields: ["PRICE"] }],
    leftover: [],
  };
  const ledger: ClaimLedger = {
    claims: [{
      claimId: "claim-price",
      kind: "PRICE",
      canonicalValue: { amount: "2100.00", currency: "CNY", basis: "FX_ESTIMATE", fxSnapshotId: "fx-1" },
      renderedText: "这款按已记录汇率估算约为人民币 2100 元。",
      evidenceRefs: [{
        artifactRef: "artifact-1",
        jsonPath: "$.price.amount",
        source: "buywhere",
        observedAt: "2026-08-26T00:00:00.000Z",
        sourceFactRef: "fact-price-1",
        canonicalValue: { amount: "300", currency: "USD" },
        providerSchemaVersion: "buywhere-v1",
        policyVersion: "proof-carrying-v1",
        derivation: "DERIVED",
        fxSnapshotId: "fx-1",
      }],
      offerRefs: ["offer-1"],
    }],
  };
  const envelope: AssistantEnvelope = {
    outcome: "CHAT",
    addressedOpIds: ["inspect"],
    blocks: [{ type: "TRANSITION", text: "我按当前证据看了一下。" }, { type: "CLAIM", claimId: "claim-price" }],
    nextMoves: [],
  };
  const context = {
    plan,
    claimLedger: ledger,
    allowedOfferRefs: new Set(["offer-1"]),
    allowedQuestionSlotIds: new Set<string>(),
    allowedDisclosureCodes: new Set<string>(),
  };

  it("validates addressed operations, evidence, and working-set membership", () => {
    expect(validateAssistantEnvelope(envelope, context)).toEqual(envelope);
    expect(renderAssistantEnvelope(envelope, ledger)).toContain("2100 元");
  });

  it("rejects unaddressed operations, unknown claims, and out-of-world claims", () => {
    expect(() => validateAssistantEnvelope({ ...envelope, addressedOpIds: [] }, context)).toThrowError(/inspect/);
    expect(() => validateAssistantEnvelope({ ...envelope, blocks: [{ type: "CLAIM", claimId: "missing" }] }, context)).toThrowError(/missing/);
    expect(() => validateAssistantEnvelope(envelope, { ...context, allowedOfferRefs: new Set() })).toThrowError(/working set/i);
  });

  it("keeps numeric facts out of model-authored transition text", () => {
    expect(() => validateAssistantEnvelope({ ...envelope, blocks: [{ type: "TRANSITION", text: "它现在卖 2100 元。" }] }, context)).toThrowError(/FACTUAL_TRANSITION/);
  });

  it("keeps unsupported product-quality superlatives out of transition text", () => {
    expect(() => validateAssistantEnvelope({ ...envelope, blocks: [{ type: "TRANSITION", text: "这是最值得买的首选。" }] }, context)).toThrowError(/UNSUPPORTED_RANKING_TRANSITION/);
  });
});
