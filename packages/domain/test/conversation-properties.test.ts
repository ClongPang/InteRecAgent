import { describe, expect, it } from "vitest";

import {
  applyGoalOperations,
  claimEvidenceKey,
  createGoalRevision,
  createWorkingSet,
  DomainError,
  emptyDialogueState,
  emptyShoppingGoal,
  evaluateConversationPolicy,
  exactPreviousGoalRevision,
  refilterWorkingSetByMarkets,
  rejectWorkingSetOffers,
  sortWorkingSetByPrice,
  renderAssistantEnvelope,
  setWorkingSetFocus,
  applyDialogueOperations,
  synchronizeDialogueState,
  validateWorkingSet,
  validateGroundedClaimSet,
  type CandidateView,
  type GroundedClaimSet,
  type ConversationState,
  type GoalOperation,
  type TurnPlan,
} from "../src/index.js";

const source = { messageId: "message-property" };

function offer(offerRef: string, market: string, amount: string, claimId: string): CandidateView {
  return {
    offerRef,
    title: `Sony WH-1000XM5 ${offerRef}`,
    canonicalModel: "WH-1000XM5",
    categoryId: "headphones",
    itemRole: "PRIMARY_PRODUCT",
    condition: "NEW",
    retrievalMarket: market,
    merchant: `Merchant ${offerRef}`,
    cnyAmount: amount,
    stock: "IN_STOCK",
    claimIds: [claimId],
  };
}

function stateWithGoal(operations: GoalOperation[] = []): ConversationState {
  const goalRevision = createGoalRevision(null, [
    {
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
    },
    ...operations,
  ], "turn-base");
  return {
    revision: 1,
    status: "OPEN",
    goalRevision,
    workingSet: null,
    dialogue: { pendingClarification: null, pendingOps: [], focusOfferRef: null, comparisonOfferRefs: [], lastAssistantMessageId: null },
  };
}

function expectPolicyError(input: Parameters<typeof evaluateConversationPolicy>[0], code: string): void {
  try {
    evaluateConversationPolicy(input);
    throw new Error(`Expected policy error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("conversation domain properties", () => {
  it("keeps set-like goal operations idempotent across representative values", () => {
    const operations: GoalOperation[] = [
      { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "2500.00", currency: "cny" } },
      { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["sg", "US", "SG"] },
      { opId: "constraint", kind: "GOAL_UPSERT_CONSTRAINT", source, constraint: { key: "color", operator: "EQ", value: "black" } },
      { opId: "preference", kind: "GOAL_UPSERT_PREFERENCE", source, preference: { key: "price", value: "lower", weight: 0.8 } },
      { opId: "exclude", kind: "GOAL_EXCLUDE_ENTITY", source, entity: { kind: "BRAND", value: "Bose" } },
    ];
    for (const operation of operations) {
      const once = applyGoalOperations(emptyShoppingGoal(), [operation]);
      const replay = { ...operation, opId: `${operation.opId}-replay` } as GoalOperation;
      expect(applyGoalOperations(once, [replay])).toEqual(once);
    }
  });

  it("undo always returns the exact parent, not a reconstructed approximation", () => {
    const revisions = [];
    let current = createGoalRevision(null, [{ opId: "b1", kind: "GOAL_SET_BUDGET", source, budget: { amount: "1000", currency: "CNY" } }], "turn-1");
    revisions.push(current);
    for (let index = 2; index <= 8; index += 1) {
      const parent = current;
      current = createGoalRevision(parent, [{ opId: `b${index}`, kind: "GOAL_SET_BUDGET", source, budget: { amount: String(index * 1000), currency: "CNY" } }], `turn-${index}`);
      revisions.push(current);
      expect(exactPreviousGoalRevision(revisions, current.version)).toEqual(parent);
    }
  });

  it("creates a monotone branch version after undo without overwriting old history", () => {
    const first = createGoalRevision(null, [{ opId: "b1", kind: "GOAL_SET_BUDGET", source, budget: { amount: "1000", currency: "CNY" } }], "turn-1");
    const second = createGoalRevision(first, [{ opId: "b2", kind: "GOAL_SET_BUDGET", source, budget: { amount: "2000", currency: "CNY" } }], "turn-2");
    const restored = exactPreviousGoalRevision([first, second], second.version);
    const branch = createGoalRevision(restored, [{ opId: "b3", kind: "GOAL_SET_BUDGET", source, budget: { amount: "1500", currency: "CNY" } }], "turn-3", 3);
    expect(branch).toMatchObject({ version: 3, parentVersion: 1, goal: { budget: { amount: "1500", currency: "CNY" } } });
    expect(() => createGoalRevision(restored, [], "turn-bad", 1)).toThrowError(/advance beyond/i);
  });

  it("working-set view operations preserve the candidate universe and rejection is monotone", () => {
    const pool = [offer("o1", "US", "2100", "p1"), offer("o2", "SG", "1900", "p2"), offer("o3", "US", "2300", "p3")];
    const base = createWorkingSet({ version: 1, boundGoalVersion: 1, pool });
    let current = base;
    for (const ref of ["o1", "o2", "o3"]) {
      const previousRejected = new Set(current.rejectedOfferRefs);
      current = rejectWorkingSetOffers(current, [ref]);
      expect(current.pool).toEqual(base.pool);
      expect([...previousRejected].every((value) => current.rejectedOfferRefs.includes(value))).toBe(true);
    }
    expect(refilterWorkingSetByMarkets(base, ["SG"]).pool).toEqual(base.pool);
    expect(sortWorkingSetByPrice(base).pool).toEqual(base.pool);
    expect(setWorkingSetFocus(base, "o2").pool).toEqual(base.pool);
  });

  it("rejects hydrated working sets that violate referential invariants", () => {
    const base = createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [offer("o1", "US", "2100", "p1"), offer("o2", "SG", "1900", "p2")] });
    expect(() => validateWorkingSet({ ...base, comparisonOfferRefs: ["o1"] })).toThrowError(/empty or contain 2-4/i);
    expect(() => validateWorkingSet({ ...base, rejectedOfferRefs: ["o1"], displayOfferRefs: ["o1", "o2"] })).toThrowError(/cannot remain/i);
  });

  it("updates dialogue state through deterministic operations and synchronizes turn context", () => {
    const waiting = applyDialogueOperations(emptyDialogueState(), [
      { kind: "DIALOGUE_REQUEST_CLARIFICATION", clarificationId: "clarification-1", clarification: { kind: "BUDGET" }, askedByMessageId: "assistant-1" },
      { kind: "DIALOGUE_RECORD_ASSISTANT_MESSAGE", messageId: "assistant-1" },
    ]);
    expect(waiting.pendingClarification).toEqual({ clarificationId: "clarification-1", clarification: { kind: "BUDGET" }, askedByMessageId: "assistant-1" });
    const workingSet = setWorkingSetFocus(createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [offer("o1", "US", "2100", "p1")] }), "o1");
    const synchronized = synchronizeDialogueState(waiting, workingSet);
    expect(synchronized).toMatchObject({ focusOfferRef: "o1", comparisonOfferRefs: [], lastAssistantMessageId: "assistant-1" });
    expect(applyDialogueOperations(synchronized, [{ kind: "DIALOGUE_CLEAR_CLARIFICATION", clarification: { kind: "BUDGET" } }]).pendingClarification).toBeNull();
  });
});

describe("conversation policy", () => {
  it("allows exactly one provider call only for an evidenced search need", () => {
    const plan: TurnPlan = { userIntentSummary: "refresh current offers", ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "USER_REQUESTED_REFRESH" }], leftover: [] };
    const state = stateWithGoal([{ opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] }]);
    expect(evaluateConversationPolicy({ plan, state, searchNeed: "USER_REQUESTED_REFRESH" })).toMatchObject({ route: "search", providerCallsAllowed: 1 });
    expect(evaluateConversationPolicy({ plan, state, searchNeed: "NOT_NEEDED" })).toMatchObject({ route: "search", providerCallsAllowed: 1 });
    const unnecessary: TurnPlan = { ...plan, ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }] };
    expect(() => evaluateConversationPolicy({ plan: unnecessary, state, searchNeed: "NOT_NEEDED" })).toThrowError(/not allowed/i);
  });

  it("keeps talk and local-state-only turns on the zero-provider path", () => {
    const plan: TurnPlan = { userIntentSummary: "focus the current offer", ops: [{ opId: "focus", kind: "SET_FOCUS", referent: null }], leftover: [] };
    expect(evaluateConversationPolicy({ plan, state: stateWithGoal(), searchNeed: "NOT_NEEDED" })).toMatchObject({ route: "talk", providerCallsAllowed: 0, reasonCodes: ["ZERO_PROVIDER_ROUTE"] });
  });

  it("requires the agent to repair a plan that omits search after becoming search-ready", () => {
    const plan: TurnPlan = {
      userIntentSummary: "finish the initial shopping goal",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "2500", currency: "CNY" } },
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US", "SG"] },
      ],
      leftover: [],
    };
    expectPolicyError({ plan, state: stateWithGoal(), searchNeed: "INSUFFICIENT_COVERAGE" }, "SEARCH_OPERATION_REQUIRED");
  });

  it("never replaces a proposed clarification with a host-generated search", () => {
    const plan: TurnPlan = {
      userIntentSummary: "compare an exact phone across two markets",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "9000", currency: "CNY" } },
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US", "SG"] },
        { opId: "ask-destination", kind: "REQUEST_CLARIFICATION", clarification: { kind: "DELIVERY_DESTINATION" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "DELIVERY_DESTINATION_REQUIRED" },
      ],
      leftover: [],
    };
    const decision = evaluateConversationPolicy({ plan, state: stateWithGoal(), searchNeed: "INSUFFICIENT_COVERAGE" });
    expect(decision.plan).toEqual(plan);
    expect(decision).toMatchObject({ route: "clarify", providerCallsAllowed: 0 });
  });

  it("never canonicalizes one proposed clarification into another", () => {
    const plan: TurnPlan = {
      userIntentSummary: "ask an unnecessary product detail",
      ops: [
        { opId: "gap", kind: "GOAL_ADD_GAP", source, gap: { slotId: "form_factor", reasonCodes: ["MODEL_SELECTED"] } },
        { opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "FORM_FACTOR" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "MODEL_SELECTED" },
      ],
      leftover: [],
    };
    const decision = evaluateConversationPolicy({ plan, state: stateWithGoal(), searchNeed: "INSUFFICIENT_COVERAGE" });
    expect(decision.plan).toEqual(plan);
    expect(decision).toMatchObject({
      route: "clarify",
      providerCallsAllowed: 0,
      reasonCodes: expect.arrayContaining(["BLOCKING_CLARIFICATION"]),
    });
  });

  it("rejects premature search without inserting a host-generated clarification", () => {
    const plan: TurnPlan = {
      userIntentSummary: "record a preference and continue",
      ops: [
        { opId: "preference", kind: "GOAL_UPSERT_PREFERENCE", source, preference: { key: "use_case", value: "commute", weight: 0.7 } },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "GOAL_BECAME_SEARCH_READY" },
      ],
      leftover: [],
    };
    expectPolicyError({ plan, state: stateWithGoal(), searchNeed: "INSUFFICIENT_COVERAGE" }, "SEARCH_MARKETS_REQUIRED");
  });

  it("does not replace a clarification when a target correction invalidates the working set", () => {
    const state = stateWithGoal([{ opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] }]);
    state.workingSet = createWorkingSet({
      version: 1,
      boundGoalVersion: state.goalRevision!.version,
      pool: [offer("o1", "US", "2100", "p1")],
    });
    const plan: TurnPlan = {
      userIntentSummary: "correct the model",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          source,
          target: { categoryId: "headphones", canonicalModel: "WH-1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
        },
        { opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "TURN_REPHRASE" }, uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true }, reasonCode: "MODEL_UNCERTAIN" },
      ],
      leftover: [],
    };
    const decision = evaluateConversationPolicy({ plan, state, searchNeed: "NOT_NEEDED" });
    expect(decision.plan).toEqual(plan);
    expect(decision).toMatchObject({ route: "clarify", providerCallsAllowed: 0 });
  });

  it("rejects redundant provider search without removing it from the proposed plan", () => {
    const state = stateWithGoal([
      { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "2500", currency: "CNY" } },
      { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US", "SG"] },
    ]);
    state.workingSet = createWorkingSet({
      version: 1,
      boundGoalVersion: state.goalRevision!.version,
      pool: [offer("o1", "US", "2100", "p1"), offer("o2", "SG", "1900", "p2")],
    });
    const plan: TurnPlan = {
      userIntentSummary: "narrow to Singapore",
      ops: [
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["SG"] },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
      ],
      leftover: [],
    };
    expectPolicyError({ plan, state, searchNeed: "NOT_NEEDED" }, "UNNECESSARY_PROVIDER_SEARCH");
  });

  it("rejects search with missing basic fields or unresolved goal gaps", () => {
    const plan: TurnPlan = { userIntentSummary: "search", ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }], leftover: [] };
    const empty: ConversationState = { ...stateWithGoal(), goalRevision: null };
    expectPolicyError({ plan, state: empty, searchNeed: "INSUFFICIENT_COVERAGE" }, "SEARCH_TARGET_REQUIRED");
    const unresolved = stateWithGoal([
      { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] },
      { opId: "gap", kind: "GOAL_ADD_GAP", source, gap: { slotId: "budget", reasonCodes: ["HIGH_IMPACT"] } },
    ]);
    expectPolicyError({ plan, state: unresolved, searchNeed: "INSUFFICIENT_COVERAGE" }, "SEARCH_BLOCKED_BY_GOAL_GAPS");
  });

  it("rejects provider search without a retrieval market instead of inserting clarification", () => {
    const state = stateWithGoal();
    const plan: TurnPlan = {
      userIntentSummary: "search before the market is known",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    };
    expectPolicyError({ plan, state, searchNeed: "INSUFFICIENT_COVERAGE" }, "SEARCH_MARKETS_REQUIRED");
  });

  it("accepts an agent-proposed disclosed exploratory scope after market clarification is skipped", () => {
    const state = stateWithGoal();
    state.dialogue = applyDialogueOperations(emptyDialogueState(), [{
      kind: "DIALOGUE_RECORD_CLARIFICATION_OUTCOME",
      clarification: { kind: "PURCHASE_MARKET" },
      outcome: "SKIPPED",
      goalVersion: state.goalRevision?.version ?? null,
    }]);
    const plan: TurnPlan = {
      userIntentSummary: "continue without choosing a market",
      ops: [{
        opId: "search",
        kind: "SEARCH_OFFERS",
        reasonCode: "INSUFFICIENT_COVERAGE",
        marketScope: ["US", "SG"],
        assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
      }],
      leftover: [],
    };
    const decision = evaluateConversationPolicy({
      plan,
      state,
      searchNeed: "INSUFFICIENT_COVERAGE",
    });
    expect(decision).toMatchObject({
      route: "search",
      providerCallsAllowed: 1,
      projectedGoal: { retrievalMarkets: [] },
      plan,
    });
  });
});

describe("claim verifier", () => {
  const evidence = {
    artifactRef: "artifact-1",
    jsonPath: "$.price.amount",
    source: "buywhere",
    observedAt: "2026-08-26T00:00:00.000Z",
    sourceFactRef: "fact-price-1",
    canonicalValue: { amount: "300", currency: "USD" },
    providerSchemaVersion: "buywhere-v1",
    policyVersion: "source-grounding-v1",
    derivation: "DERIVED" as const,
    fxSnapshotId: "fx-1",
  };
  const ledger: GroundedClaimSet = { claims: [{
    claimId: "price-1",
    kind: "PRICE",
    canonicalValue: { amount: "2100.00", currency: "CNY", basis: "FX_ESTIMATE", fxSnapshotId: "fx-1" },
    renderedText: "按已记录汇率估算约为人民币 2100 元。",
    evidenceRefs: [evidence],
    offerRefs: ["o1"],
  }] };
  const workingSet = createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [offer("o1", "US", "2100", "price-1")] });

  it("accepts only claims bound to both the working set and the attempt evidence chain", () => {
    const allowed = new Set([claimEvidenceKey(evidence)]);
    expect(validateGroundedClaimSet(ledger, { workingSet, allowedEvidenceRefs: allowed })).toEqual(ledger);
    expect(() => validateGroundedClaimSet(ledger, { workingSet, allowedEvidenceRefs: new Set() })).toThrowError(/outside the committed attempt/i);
  });

  it("uses the same deterministic wording for unknown-field disclosures in rendering and verification", () => {
    const envelope = {
      outcome: "CHAT" as const,
      addressedOpIds: ["inspect"],
      blocks: [
        { type: "CLAIM" as const, claimId: "price-1" },
        { type: "DISCLOSURE" as const, disclosureCode: "WARRANTY_UNKNOWN" },
      ],
      nextMoves: [],
    };
    const renderedDraft = renderAssistantEnvelope(envelope, ledger);
    expect(renderedDraft).toContain("当前来源没有提供可验证的保修信息。");
    expect(validateGroundedClaimSet(ledger, { workingSet, envelope, renderedDraft })).toEqual(ledger);
  });

  it("renders historical search gaps as coverage limits rather than market absence", () => {
    const rendered = renderAssistantEnvelope({
      outcome: "CHAT",
      addressedOpIds: ["coverage"],
      blocks: [{ type: "DISCLOSURE", disclosureCode: "SEARCH_COVERAGE_INCOMPLETE:SG" }],
      nextMoves: [],
    }, { claims: [] });
    expect(rendered).toBe("历史检索中 SG 市场的数据未成功返回；这表示覆盖不完整，不代表当地没有销售。");
  });

  it("rejects price mismatches, rejected offers, and unbound claims", () => {
    const wrongPrice: GroundedClaimSet = { claims: [{ ...ledger.claims[0]!, canonicalValue: { amount: "1", currency: "CNY" } }] };
    expect(() => validateGroundedClaimSet(wrongPrice, { workingSet })).toThrowError(/does not match/i);
    expect(() => validateGroundedClaimSet(ledger, { workingSet: rejectWorkingSetOffers(workingSet, ["o1"]) })).toThrowError(/rejected offer/i);
    const unbound = createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [offer("o1", "US", "2100", "another-claim")] });
    expect(() => validateGroundedClaimSet(ledger, { workingSet: unbound })).toThrowError(/not bound/i);
  });

  it("validates ranking-reason arrays against the deterministic working-set projection", () => {
    const reasons = ["VERIFIED", "PROVIDER_ATTESTED", "LEXICOGRAPHIC_RANK_VECTOR_V1"];
    const rankingEvidence = {
      ...evidence,
      jsonPath: "$.availability",
      sourceFactRef: "fact-ranking-1",
      canonicalValue: "local",
    };
    const rankingLedger: GroundedClaimSet = { claims: [{
      claimId: "ranking-1",
      kind: "RANKING_REASON",
      canonicalValue: reasons,
      renderedText: `当前排序依据：${reasons.join("、")}`,
      evidenceRefs: [rankingEvidence],
      offerRefs: ["o1"],
    }] };
    const ranked = createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [{ ...offer("o1", "US", "2100", "ranking-1"), rankingReasonCodes: reasons }],
    });
    expect(validateGroundedClaimSet(rankingLedger, { workingSet: ranked })).toEqual(rankingLedger);
    const mismatched = createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [{ ...ranked.pool[0]!, rankingReasonCodes: ["VERIFIED"] }],
    });
    expect(() => validateGroundedClaimSet(rankingLedger, { workingSet: mismatched })).toThrowError(/does not match/i);
  });

  it("compares different models within one source-grounded product scope", () => {
    const secondEvidence = { ...evidence, artifactRef: "artifact-2", sourceFactRef: "fact-price-2" };
    const comparisonLedger: GroundedClaimSet = { claims: [
      ledger.claims[0]!,
      {
        ...ledger.claims[0]!,
        claimId: "price-2",
        canonicalValue: { amount: "1900.00", currency: "CNY", basis: "FX_ESTIMATE", fxSnapshotId: "fx-1" },
        renderedText: "另一个型号按已记录汇率估算约为人民币 1900 元。",
        evidenceRefs: [secondEvidence],
        offerRefs: ["o2"],
      },
    ] };
    const second = { ...offer("o2", "SG", "1900", "price-2"), title: "Bose QuietComfort", canonicalModel: "BOSE QUIETCOMFORT" };
    const rankedOfferSet = createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [offer("o1", "US", "2100", "price-1"), second] });
    const envelope = {
      outcome: "CHAT" as const,
      addressedOpIds: ["inspect"],
      blocks: [{ type: "COMPARISON" as const, claimIds: ["price-1", "price-2"] }],
      nextMoves: [],
    };
    expect(validateGroundedClaimSet(comparisonLedger, { workingSet: rankedOfferSet, envelope })).toEqual(comparisonLedger);
    const accessorySet = createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [rankedOfferSet.pool[0]!, { ...second, itemRole: "ACCESSORY" }],
    });
    expect(() => validateGroundedClaimSet(comparisonLedger, { workingSet: accessorySet, envelope })).toThrowError(/category and item role/);
  });
});
