import {
  createGoalRevision,
  createWorkingSet,
  emptyDialogueState,
  type CandidateProjection,
  type ConversationState,
} from "@interec/domain";
import { describe, expect, it } from "vitest";

import {
  ConversationTurnDraftHost,
  type TurnDraftSnapshot,
  type TurnWorldPort,
} from "../src/index.js";

const source = { messageId: "base-message" };

function candidate(offerRef: string, amount: string): CandidateProjection {
  return {
    offerRef,
    title: `Sony WH-1000XM5 ${offerRef}`,
    canonicalModel: "WH-1000XM5",
    categoryId: "headphones",
    itemRole: "PRIMARY_PRODUCT",
    condition: "NEW",
    retrievalMarket: "US",
    merchant: `Merchant ${offerRef}`,
    cnyAmount: amount,
    stock: "UNKNOWN",
    claimIds: [],
  };
}

function baseState(): ConversationState {
  const goalRevision = createGoalRevision(null, [{
    opId: "target",
    kind: "GOAL_SET_TARGET",
    source,
    target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
  }], "base-turn");
  return {
    revision: 1,
    status: "OPEN",
    goalRevision,
    dialogue: emptyDialogueState(),
    workingSet: createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [candidate("offer-1", "2100"), candidate("offer-2", "1900"), candidate("offer-3", "2300")],
    }),
  };
}

function world(inspected: string[][] = []): TurnWorldPort {
  return {
    inspect: async (_operation, refs) => {
      inspected.push(refs);
      return { claims: [], disclosureCodes: [], publicResult: { inspectedOfferRefs: refs } };
    },
    research: async () => { throw new Error("RESEARCH_NOT_EXPECTED"); },
  };
}

describe("deterministic turn draft host", () => {
  it("requires pi-agent to plan the exact durable UI focus before answering", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-focus",
      inputMessageIds: ["message-focus"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      requiredFocusOfferRef: "offer-2",
      world: world(),
      loadRevision: async () => null,
    });
    await expect(host.commitPlan({
      userIntentSummary: "answer without planning UI focus",
      ops: [{ opId: "inspect-wrong", kind: "INSPECT_WORKING_SET", referents: [{ kind: "OFFER_REF", offerRef: "offer-1" }], fields: ["STOCK"] }],
      leftover: [],
    }))
      .rejects.toMatchObject({ code: "UI_FOCUS_NOT_PLANNED" });
    await expect(host.commitPlan({
      userIntentSummary: "focus exact candidate before answering",
      ops: [{ opId: "focus", kind: "SET_FOCUS", referent: { kind: "OFFER_REF", offerRef: "offer-2" } }],
      leftover: [],
    })).resolves.toMatchObject({ plan: { ops: [{ kind: "SET_FOCUS", referent: { offerRef: "offer-2" } }] } });
  });

  it("discards model provenance attached to world operations", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-world-provenance",
      inputMessageIds: ["message-world-provenance"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "inspect with harmless model provenance",
      ops: [{
        opId: "inspect",
        kind: "INSPECT_WORKING_SET",
        sourceMessageOrdinal: 0,
        sourceSpan: { start: 0, end: 3 },
        referents: [{ kind: "DISPLAY_RANK", rank: 1 }],
        fields: ["PRICE"],
      }],
      leftover: [],
    });
    expect(committed.plan.ops[0]).toEqual({
      opId: "inspect",
      kind: "INSPECT_WORKING_SET",
      referents: [{ kind: "OFFER_REF", offerRef: "offer-1" }],
      fields: ["PRICE"],
    });
  });

  it("discards unsupported Goal values and normalizes an unstated condition to ANY", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-source-support",
      inputMessageIds: ["message-source-support"],
      inputMessageContents: ["想买一款通勤用的降噪耳机"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "headphones for commuting",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
        },
        { opId: "invented-budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "1000", currency: "CNY" } },
        { opId: "ask-budget", kind: "REQUEST_CLARIFICATION", slotId: "budget", reasonCode: "BUDGET_UNDEFINED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([
      {
        opId: "target",
        kind: "GOAL_SET_TARGET",
        source: { messageId: "message-source-support" },
        target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      },
      { opId: "ask-budget", kind: "REQUEST_CLARIFICATION", slotId: "budget", reasonCode: "BUDGET_UNDEFINED" },
    ]);
  });

  it("grounds an open-category target in source text and removes explicit no-budget placeholders", async () => {
    const message = "I want a front load washing machine in US with no budget";
    const host = new ConversationTurnDraftHost({
      turnId: "turn-open-no-budget",
      inputMessageIds: ["message-open-no-budget"],
      inputMessageContents: [message],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "open-category product request without a budget",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "washing_machine", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
        },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] },
        { opId: "empty-budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "", currency: "" } },
        { opId: "ask-budget", kind: "REQUEST_CLARIFICATION", slotId: "budget", reasonCode: "BUDGET_UNDEFINED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([
      {
        opId: "target",
        kind: "GOAL_SET_TARGET",
        source: { messageId: "message-open-no-budget" },
        target: {
          categoryId: "washing_machine",
          targetText: message,
          canonicalModel: null,
          itemRole: "PRIMARY_PRODUCT",
          condition: "ANY",
        },
      },
      {
        opId: "market",
        kind: "GOAL_SET_RETRIEVAL_MARKETS",
        source: { messageId: "message-open-no-budget" },
        markets: ["US"],
      },
    ]);
  });

  it("binds a yuan budget to CNY instead of trusting a model-invented currency", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-budget-currency",
      inputMessageIds: ["message-budget-currency"],
      inputMessageContents: ["预算 2500 元，比较美国和新加坡"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "set the stated budget",
      ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CAD" } }],
      leftover: [],
    });
    expect(committed.plan.ops[0]).toMatchObject({ kind: "GOAL_SET_BUDGET", budget: { amount: "2500", currency: "CNY" } });
  });

  it("limits ordinal rejection to the explicitly named displayed rank", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-ordinal-reject",
      inputMessageIds: ["message-ordinal-reject"],
      inputMessageContents: ["只看新加坡，而且不要第二个"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "reject only the second candidate",
      ops: [
        { opId: "reject-2", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
        { opId: "reject-1", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 1 }], reasonCode: "USER_REJECTED" },
        { opId: "reject-3", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 3 }], reasonCode: "USER_REJECTED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{
      opId: "reject-2",
      kind: "REJECT_OFFERS",
      referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }],
      reasonCode: "USER_REJECTED",
    }]);
  });

  it("enriches an exact smartphone model from source text and drops redundant storage constraints", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-exact-model",
      inputMessageIds: ["message-exact-model"],
      inputMessageContents: ["想买 iPhone 16 Pro 256GB 新机"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "exact phone target",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "smartphone", canonicalModel: "iPhone 16 Pro", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
        },
        {
          opId: "storage",
          kind: "GOAL_UPSERT_CONSTRAINT",
          sourceMessageOrdinal: 0,
          constraint: { key: "storage_capacity", operator: "EQ", value: "256GB" },
        },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source: { messageId: "message-exact-model" },
      target: { categoryId: "smartphone", canonicalModel: "IPHONE 16 PRO 256GB", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
    }]);
  });

  it("turns empty-working-set referent failures into a specific clarification fallback", async () => {
    const current = baseState();
    current.workingSet = createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [] });
    const host = new ConversationTurnDraftHost({
      turnId: "turn-empty-referent",
      inputMessageIds: ["message-empty-referent"],
      inputMessageContents: ["第二个和第一个差在哪？"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "compare missing candidates",
      ops: [{
        opId: "inspect",
        kind: "INSPECT_WORKING_SET",
        referents: [{ kind: "DISPLAY_RANK", rank: 1 }, { kind: "DISPLAY_RANK", rank: 2 }],
        fields: ["PRICE"],
      }],
      leftover: [],
    });
    const receipt = await host.executeOperation(committed.plan.ops[0]!);
    expect(receipt).toMatchObject({ status: "BLOCKED", questionSlotIds: ["referent:inspect"] });
    await expect(host.fallbackReply("MODEL_DID_NOT_PUBLISH", committed.plan, [receipt])).resolves.toMatchObject({
      outcome: "CLARIFICATION",
      blocks: [{ type: "QUESTION", slotId: "referent:inspect" }],
    });
  });

  it("clears an obsolete referent clarification when a new Goal instruction supersedes it", async () => {
    const current = baseState();
    current.dialogue = {
      ...current.dialogue,
      pendingClarification: { slotId: "referent:inspect", askedByMessageId: "previous-turn" },
    };
    const snapshots: TurnDraftSnapshot[] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-new-goal",
      inputMessageIds: ["message-new-goal"],
      inputMessageContents: ["只看美国"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
    });
    const committed = await host.commitPlan({
      userIntentSummary: "narrow market",
      ops: [{ opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] }],
      leftover: [],
    });
    await host.executeOperation(committed.plan.ops[0]!);
    expect(snapshots.at(-1)?.state.dialogue.pendingClarification).toBeNull();
  });

  it("stabilizes all referents against the observation snapshot before ordered mutations", async () => {
    const inspected: string[][] = [];
    const snapshots: TurnDraftSnapshot[] = [];
    let published: Parameters<NonNullable<ConstructorParameters<typeof ConversationTurnDraftHost>[0]["onReplyValidated"]>>[0] | null = null;
    const host = new ConversationTurnDraftHost({
      turnId: "turn-2",
      inputMessageIds: ["message-2"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(inspected),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
      onReplyValidated: async (value) => { published = value; },
    });
    const committed = await host.commitPlan({
      userIntentSummary: "reject second, prefer cheaper, inspect original third",
      ops: [
        { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
        { opId: "rerank", kind: "RERANK_WORKING_SET", preferenceKey: "price:lower" },
        { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 3 }], fields: ["PRICE"] },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { opId: "reject", referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }] },
      { opId: "rerank" },
      { opId: "inspect", referents: [{ kind: "OFFER_REF", offerRef: "offer-3" }] },
    ]);
    for (const operation of committed.plan.ops) await host.executeOperation(operation);
    expect(inspected).toEqual([["offer-3"]]);
    await host.publishReply({
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }],
      nextMoves: [],
    });
    expect(snapshots.at(-1)?.state.workingSet).toMatchObject({
      version: 2,
      rejectedOfferRefs: ["offer-2"],
      displayOfferRefs: ["offer-1", "offer-3"],
      mentionedOfferRefs: ["offer-3"],
    });
    expect(published).toMatchObject({ state: { revision: 2 }, evidenceKeys: [], renderedText: "我已更新当前选购状态。" });
  });

  it("reranks by a durable generic preference without requiring category code", async () => {
    const snapshots: TurnDraftSnapshot[] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-generic-rerank",
      inputMessageIds: ["message-generic-rerank"],
      inputMessageContents: ["更偏好低噪音，基于当前候选重新排序"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
    });
    const committed = await host.commitPlan({
      userIntentSummary: "prefer lower noise and rerank current candidates",
      ops: [
        {
          opId: "preference",
          kind: "GOAL_UPSERT_PREFERENCE",
          sourceMessageOrdinal: 0,
          preference: { key: "noise_level", value: "low", weight: 0.7 },
        },
        { opId: "rerank", kind: "RERANK_WORKING_SET", preferenceKey: "noise_level" },
      ],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await host.executeOperation(operation);
    expect(snapshots.at(-1)?.state.workingSet?.displayOfferRefs).toEqual(["offer-1", "offer-2", "offer-3"]);
    expect(snapshots.at(-1)?.state.goalRevision?.goal.preferences).toMatchObject([
      { key: "noise_level", value: "low", weight: 0.7 },
    ]);
  });

  it("binds goal operation ordinals and creates one monotone goal version for the whole turn", async () => {
    let finalSnapshot: TurnDraftSnapshot | null = null;
    const host = new ConversationTurnDraftHost({
      turnId: "turn-budget",
      inputMessageIds: ["real-user-message"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { finalSnapshot = snapshot; },
    });
    const committed = await host.commitPlan({
      userIntentSummary: "change budget and market",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] },
      ],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await host.executeOperation(operation);
    expect(finalSnapshot?.state.goalRevision).toMatchObject({
      version: 2,
      parentVersion: 1,
      goal: { budget: { amount: "2500", currency: "CNY" }, retrievalMarkets: ["US"] },
      operations: [
        { opId: "budget", source: { messageId: "real-user-message" } },
        { opId: "market", source: { messageId: "real-user-message" } },
      ],
    });
    expect(finalSnapshot?.state.workingSet).toMatchObject({ version: 2, boundGoalVersion: 2 });
  });

  it("enforces the zero-provider policy before staging research", async () => {
    let planCommitted = false;
    const host = new ConversationTurnDraftHost({
      turnId: "turn-policy",
      inputMessageIds: ["message-policy"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onPlanCommitted: async () => { planCommitted = true; },
    });
    await expect(host.commitPlan({
      userIntentSummary: "unnecessary refresh",
      ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "NOT_NEEDED" }],
      leftover: [],
    })).rejects.toMatchObject({ code: "UNNECESSARY_PROVIDER_RESEARCH" });
    expect(planCommitted).toBe(false);
  });

  it("materializes an evidence-safe no-match reply without discarding completed research", async () => {
    const current = baseState();
    current.workingSet = null;
    const host = new ConversationTurnDraftHost({
      turnId: "turn-no-match",
      inputMessageIds: ["message-no-match"],
      baseState: current,
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        research: async () => ({
          workingSet: createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [] }),
          result: {
            claims: [],
            disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"],
            publicResult: { candidates: [] },
          },
        }),
      },
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "research the current goal",
      ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    });
    await host.executeOperation(committed.plan.ops[0]!);
    const envelope = await host.publishReply({
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "RESEARCH_COMPLETED" }],
      nextMoves: [],
    });
    expect(envelope).toMatchObject({
      outcome: "NO_MATCH",
      addressedOpIds: ["research"],
      blocks: [
        { type: "TRANSITION", text: "我已完成本轮检索和证据校验。" },
        { type: "DISCLOSURE", disclosureCode: "UNVERIFIED_RESULTS_NOT_RECOMMENDED" },
      ],
    });
  });

  it("labels offer-only research as Discovery even when the model proposes a recommendation", async () => {
    const current = baseState();
    current.workingSet = null;
    const discoveryCandidate: CandidateProjection = {
      ...candidate("laptop-offer", "5593"),
      title: "Lightweight Laptop 14",
      canonicalModel: null,
      categoryId: "laptop",
      discovery: {
        supportLevel: "DISCOVERY",
        identityLevel: "OFFER_ONLY",
        identityKey: null,
        matchedPreferenceKeys: ["portable"],
        contradictedPreferenceKeys: [],
        rankVector: { eligibilityTier: 2, targetCoverage: 1, positiveCoverage: 1, negativeConflicts: 0, evidenceTier: 2, stockTier: 1, priceTieBreaker: "5593" },
      },
    };
    const host = new ConversationTurnDraftHost({
      turnId: "turn-discovery",
      inputMessageIds: ["message-discovery"],
      baseState: current,
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        research: async () => ({
          workingSet: createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [discoveryCandidate] }),
          result: { claims: [], disclosureCodes: ["DISCOVERY_OFFER_IDENTITY_ONLY"], publicResult: { candidates: [discoveryCandidate] } },
        }),
      },
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "discover laptops",
      ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    });
    await host.executeOperation(committed.plan.ops[0]!);
    const envelope = await host.publishReply({ outcome: "RECOMMENDATION", blocks: [{ type: "TRANSITION", transitionCode: "RESEARCH_COMPLETED" }], nextMoves: [] });
    expect(envelope.outcome).toBe("DISCOVERY");
    expect(envelope.blocks).toContainEqual({ type: "DISCLOSURE", disclosureCode: "DISCOVERY_OFFER_IDENTITY_ONLY" });
  });

  it("keeps one explicit question when model narration repeats the clarification", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-question",
      inputMessageIds: ["message-question"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "ask for budget",
      ops: [{ opId: "ask-budget", kind: "REQUEST_CLARIFICATION", slotId: "budget", reasonCode: "MISSING_BUDGET" }],
      leftover: [],
    });
    await host.executeOperation(committed.plan.ops[0]!);
    const envelope = await host.publishReply({
      outcome: "CLARIFICATION",
      blocks: [
        { type: "TRANSITION", transitionCode: "STATE_UPDATED" },
        { type: "QUESTION", slotId: "budget" },
      ],
      nextMoves: [],
    });
    expect(envelope.blocks).toEqual([{ type: "QUESTION", slotId: "budget", wording: "预算大概是多少？" }]);
  });

  it("turns a pre-plan model failure into a durable clarification plan and safe reply", async () => {
    const plans: string[][] = [];
    let published: { allowedQuestionSlotIds: string[]; state: ConversationState } | null = null;
    const host = new ConversationTurnDraftHost({
      turnId: "turn-fallback",
      inputMessageIds: ["message-fallback"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.opId)); },
      onReplyValidated: async (value) => { published = value; },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([["fallback-clarification"]]);
    expect(envelope).toMatchObject({ outcome: "DEGRADED", addressedOpIds: ["fallback-clarification"] });
    expect(published).toMatchObject({
      allowedQuestionSlotIds: ["turn_rephrase"],
      state: { dialogue: { pendingClarification: { slotId: "turn_rephrase" } } },
    });
  });

  it("clears a prior generic recovery clarification when the next turn stages an actionable plan", async () => {
    const current = baseState();
    current.dialogue.pendingClarification = { slotId: "turn_rephrase", askedByMessageId: "failed-turn" };
    let finalSnapshot: TurnDraftSnapshot | null = null;
    const host = new ConversationTurnDraftHost({
      turnId: "recovery-turn",
      inputMessageIds: ["recovery-message"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { finalSnapshot = snapshot; },
    });
    const committed = await host.commitPlan({
      userIntentSummary: "continue after a protocol fallback",
      ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await host.executeOperation(operation);
    expect(finalSnapshot?.state.dialogue.pendingClarification).toBeNull();
  });
});
