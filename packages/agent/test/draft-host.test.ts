import {
  createGoalRevision,
  createWorkingSet,
  emptyDialogueState,
  rejectWorkingSetOffers,
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
  const goalRevision = createGoalRevision(null, [
    {
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
    },
    { opId: "base-market", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] },
  ], "base-turn");
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
    inspectResearchCoverage: async () => ({ claims: [], disclosureCodes: [], publicResult: { found: false } }),
    research: async () => { throw new Error("RESEARCH_NOT_EXPECTED"); },
  };
}

describe("deterministic turn draft host", () => {
  it("executes historical coverage inspection without provider research and mandates its disclosure", async () => {
    let coverageInspections = 0;
    const host = new ConversationTurnDraftHost({
      turnId: "turn-coverage",
      inputMessageIds: ["message-coverage"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: {
        ...world(),
        inspectResearchCoverage: async () => {
          coverageInspections += 1;
          return {
            claims: [],
            disclosureCodes: ["RESEARCH_COVERAGE_INCOMPLETE:SG"],
            publicResult: { found: true, failedMarkets: ["SG"] },
          };
        },
      },
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "inspect the previous research coverage",
      ops: [{ opId: "coverage", kind: "INSPECT_RESEARCH_COVERAGE" }],
      leftover: [],
    });
    const receipt = await host.executeOperation(committed.plan.ops[0]!);
    const envelope = await host.publishReply({
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "CHECKED_PREMISE" }],
      nextMoves: [],
    });
    expect(coverageInspections).toBe(1);
    expect(receipt).toMatchObject({ toolName: "inspect_research_coverage", publicResult: { found: true } });
    expect(envelope.blocks[0]).toEqual({ type: "TRANSITION", text: "我先按现有证据核对这个前提。" });
    expect(envelope.blocks).toContainEqual({ type: "DISCLOSURE", disclosureCode: "RESEARCH_COVERAGE_INCOMPLETE:SG" });
  });

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

  it("does not invent a registered target when the semantic proposal omits it", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-recover-target",
      inputMessageIds: ["message-recover-target"],
      inputMessageContents: ["预算 2500 元，比较美国和新加坡的 Sony WH-1000XM5"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "compare a stated model in two markets",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } },
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["美国", "新加坡"] },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual(["GOAL_SET_BUDGET", "GOAL_SET_RETRIEVAL_MARKETS"]);
    expect(committed.plan.ops.some((operation) => operation.kind === "GOAL_SET_TARGET" || operation.kind === "RESEARCH_OFFERS")).toBe(false);
  });

  it("does not invent a market from prose when the semantic proposal omits it", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-recover-market",
      inputMessageIds: ["message-original", "message-correction"],
      inputMessageContents: ["先在美国查 Sony WH-1000XM5，最高 2600 元。", "等等，不是 XM5，是 Sony WH-1000XM4。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "use the corrected target with the original market",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 1,
          target: { categoryId: "headphones", canonicalModel: "WH1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2600", currency: "CNY" } },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual(["GOAL_SET_TARGET", "GOAL_SET_BUDGET"]);
    expect(committed.plan.ops.some((operation) => operation.kind === "GOAL_SET_RETRIEVAL_MARKETS" || operation.kind === "RESEARCH_OFFERS")).toBe(false);
  });

  it("rebinds proposed batch values to the message that actually supports their provenance", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-rebind-batch-provenance",
      inputMessageIds: ["message-original", "message-correction"],
      inputMessageContents: [
        "Search Sony WH-1000XM5 in US with maximum budget 2600 CNY.",
        "Correction: use Sony WH-1000XM4 and continue with the updated target.",
      ],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "carry the original scope into the corrected target",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 1,
          target: { categoryId: "headphones", canonicalModel: "WH1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 1, budget: { amount: "2600", currency: "CNY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["US"] },
        { opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { opId: "target", source: { messageId: "message-correction" } },
      { opId: "budget", source: { messageId: "message-original" } },
      { opId: "market", source: { messageId: "message-original" } },
      { opId: "research", kind: "RESEARCH_OFFERS" },
    ]);
  });

  it("does not silently add omitted superseding effects from raw prose", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-recover-batch-overrides",
      inputMessageIds: ["message-original", "message-override"],
      inputMessageContents: [
        "在新加坡找 Sony WH-1000XM4，不设预算。",
        "预算改成 3500 元；另外，范围扩大到美国和新加坡。",
      ],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "consume the complete superseding batch",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: "WH1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "old-market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["SG"] },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { kind: "GOAL_SET_TARGET", target: { canonicalModel: "WH1000XM4" } },
      { kind: "GOAL_SET_RETRIEVAL_MARKETS", markets: ["SG"] },
      { kind: "RESEARCH_OFFERS" },
    ]);
    expect(committed.plan.ops.some((operation) => operation.kind === "GOAL_SET_BUDGET")).toBe(false);
  });

  it("rejects an empty semantic proposal instead of reparsing a message batch", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-recover-batch-target",
      inputMessageIds: ["message-product", "message-scope"],
      inputMessageContents: [
        "美国和新加坡都找 iPhone 16 Pro 256GB，预算 10000 元。",
        "改成只看新加坡，预算也降到 9000 元。",
      ],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    await expect(host.commitPlan({ userIntentSummary: "consume a superseding scope correction", ops: [], leftover: [] }))
      .rejects.toThrow();
  });

  it("does not infer a corrected target when the semantic proposal omits it", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-recover-correction",
      inputMessageIds: ["message-recover-correction"],
      inputMessageContents: ["不是 XM5，我说错了，是 Sony WH-1000XM4。"],
      baseState: baseState(),
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "correct the target model and research again",
      ops: [{ opId: "research-corrected", kind: "RESEARCH_OFFERS", reasonCode: "TARGET_CHANGED" }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{ opId: "research-corrected", kind: "RESEARCH_OFFERS", reasonCode: "TARGET_CHANGED" }]);
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
    expect(committed.plan.ops).toEqual([
      {
        opId: "reject-2",
        kind: "REJECT_OFFERS",
        referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }],
        reasonCode: "USER_REJECTED",
      },
    ]);
  });

  it("treats a requested result count as presentation guidance rather than a blocking quantity gap", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-result-count",
      inputMessageIds: ["message-result-count"],
      inputMessageContents: ["在美国和新加坡找 Sony WH-1000XM5，预算 3200 元，给我两条。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "show two matching offers",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: "WH1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US", "SG"] },
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3200", currency: "CNY" } },
        { opId: "quantity-gap", kind: "GOAL_ADD_GAP", sourceMessageOrdinal: 0, gap: { slotId: "quantity", reasonCodes: ["quantity_requested"] } },
        { opId: "quantity-question", kind: "REQUEST_CLARIFICATION", slotId: "quantity", reasonCode: "quantity_requested" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual([
      "GOAL_SET_TARGET",
      "GOAL_SET_RETRIEVAL_MARKETS",
      "GOAL_SET_BUDGET",
      "RESEARCH_OFFERS",
    ]);
  });

  it("binds current-last rejection after applying an earlier rejection in the same plan", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-sequential-reject",
      inputMessageIds: ["message-sequential-reject"],
      inputMessageContents: ["先不要第一条，然后把现在最后一条也排除。"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "reject the first and then the current last offer",
      ops: [
        { opId: "reject-first", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 1 }], reasonCode: "USER_REJECTED" },
        { opId: "reject-last", kind: "REJECT_OFFERS", referents: [{ kind: "TEXT", text: "now last shown" }], reasonCode: "USER_REJECTED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { kind: "REJECT_OFFERS", referents: [{ kind: "OFFER_REF", offerRef: "offer-1" }] },
      { kind: "REJECT_OFFERS", referents: [{ kind: "OFFER_REF", offerRef: "offer-3" }] },
    ]);
  });

  it("binds restoration and its same-turn inspection to the sole rejected offer", async () => {
    const current = baseState();
    current.workingSet = rejectWorkingSetOffers(current.workingSet!, ["offer-2"]);
    const host = new ConversationTurnDraftHost({
      turnId: "turn-restore-and-inspect",
      inputMessageIds: ["message-restore-and-inspect"],
      inputMessageContents: ["把刚才不要的那条恢复，再说说它现在的价格。"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "restore the rejected offer and inspect it",
      ops: [
        { opId: "restore", kind: "RESTORE_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }] },
        { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 4 }], fields: ["PRICE"] },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { kind: "RESTORE_OFFERS", referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }] },
      { kind: "INSPECT_WORKING_SET", referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }], fields: ["PRICE"] },
    ]);
  });

  it("maps an offer-specific Goal restore onto the rejected working set", async () => {
    const current = baseState();
    current.workingSet = rejectWorkingSetOffers(current.workingSet!, ["offer-1", "offer-3"]);
    const host = new ConversationTurnDraftHost({
      turnId: "turn-goal-offer-restore",
      inputMessageIds: ["message-goal-offer-restore"],
      inputMessageContents: ["只撤销最近那次排除，第一条仍然不要。"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "restore only the most recently rejected offer",
      ops: [{
        opId: "restore-offer",
        kind: "GOAL_RESTORE_ENTITY",
        sourceMessageOrdinal: 0,
        entity: { kind: "OFFER", value: "offer-3" },
      }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{
      opId: "restore-offer",
      kind: "RESTORE_OFFERS",
      referents: [{ kind: "OFFER_REF", offerRef: "offer-3" }],
    }]);
  });

  it("resolves a restore rank against rejected offers when every offer is hidden", async () => {
    const current = baseState();
    current.workingSet = rejectWorkingSetOffers(current.workingSet!, ["offer-1", "offer-2", "offer-3"]);
    const host = new ConversationTurnDraftHost({
      turnId: "turn-empty-display-restore",
      inputMessageIds: ["message-empty-display-restore"],
      inputMessageContents: ["只撤销最近那次排除。"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "restore the second rejected offer",
      ops: [{ opId: "restore-second", kind: "RESTORE_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }] }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{
      opId: "restore-second",
      kind: "RESTORE_OFFERS",
      referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }],
    }]);
  });

  it("rejects an empty refresh proposal instead of reparsing prose", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-refresh-recovery",
      inputMessageIds: ["message-refresh-recovery"],
      inputMessageContents: ["范围扩大到美国和新加坡，并刷新一下当前报价。"],
      baseState: baseState(),
      researchNeed: "STALE",
      world: world(),
      loadRevision: async () => null,
    });
    await expect(host.commitPlan({ userIntentSummary: "expand markets and refresh", ops: [], leftover: [] })).rejects.toThrow();
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
          sourceSpan: { start: 3, end: 16 },
          target: { categoryId: "smartphone", canonicalModel: "iPhone 16 Pro", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
        },
        {
          opId: "storage",
          kind: "GOAL_UPSERT_CONSTRAINT",
          sourceMessageOrdinal: 0,
          constraint: { key: "model_storage", operator: "EQ", value: "256GB" },
        },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([
      {
        opId: "target",
        kind: "GOAL_SET_TARGET",
        source: { messageId: "message-exact-model" },
        target: { categoryId: "smartphone", canonicalModel: "IPHONE 16 PRO 256GB", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
      },
      { opId: "host-required-research", kind: "RESEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
    ]);
  });

  it("drops brand and model constraints already represented by a registered target", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-redundant-identity-constraints",
      inputMessageIds: ["message-redundant-identity-constraints"],
      inputMessageContents: ["找 Sony WH-1000XM4 耳机"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "set an exact target without duplicate proof constraints",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: "WH1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "brand", kind: "GOAL_UPSERT_CONSTRAINT", sourceMessageOrdinal: 0, constraint: { key: "brand", operator: "EQ", value: "Sony" } },
        { opId: "model", kind: "GOAL_UPSERT_CONSTRAINT", sourceMessageOrdinal: 0, constraint: { key: "model", operator: "EQ", value: "WH-1000XM4" } },
        { opId: "model-line", kind: "GOAL_UPSERT_CONSTRAINT", sourceMessageOrdinal: 0, constraint: { key: "model_line", operator: "CONTAINS", value: "WH-1000XM4" } },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual(["GOAL_SET_TARGET", "RESEARCH_OFFERS"]);
  });

  it("does not replace a model clarification with a prose-derived capacity correction", async () => {
    const current = baseState();
    current.goalRevision = createGoalRevision(null, [
      {
        opId: "phone-target",
        kind: "GOAL_SET_TARGET",
        source,
        target: { categoryId: "smartphone", canonicalModel: "IPHONE 16 PRO 128GB", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      },
      { opId: "phone-markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US", "SG"] },
    ], "phone-turn");
    current.workingSet = createWorkingSet({ version: 1, boundGoalVersion: current.goalRevision.version, pool: [] });
    const host = new ConversationTurnDraftHost({
      turnId: "turn-capacity-correction",
      inputMessageIds: ["message-capacity-correction"],
      inputMessageContents: ["容量改成 256GB，其他条件保持不变。"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "correct only the capacity",
      ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", slotId: "turn_rephrase", reasonCode: "MODEL_UNCERTAIN" }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{ opId: "ask", kind: "REQUEST_CLARIFICATION", slotId: "turn_rephrase", reasonCode: "MODEL_UNCERTAIN" }]);
  });

  it("normalizes an explicit undo of the current revision to its direct predecessor", async () => {
    const current = baseState();
    current.revision = 2;
    const previous = baseState();
    previous.revision = 1;
    const loaded: number[] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-normalize-undo",
      inputMessageIds: ["message-normalize-undo"],
      inputMessageContents: ["把上一次改动整个撤销。"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async (revision) => {
        loaded.push(revision);
        return revision === 1 ? previous : null;
      },
    });
    const committed = await host.commitPlan({
      userIntentSummary: "undo the last change",
      ops: [{ opId: "undo", kind: "UNDO_REVISION", revision: 2 }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{ opId: "undo", kind: "UNDO_REVISION", revision: 1 }]);
    await host.executeOperation(committed.plan.ops[0]!);
    expect(loaded).toEqual([1]);
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
    const envelope = await host.publishReply({ outcome: "CHAT", blocks: [{ type: "TRANSITION", transitionCode: "RESEARCH_COMPLETED" }], nextMoves: [] });
    expect(envelope.outcome).toBe("DISCOVERY");
    expect(envelope.blocks).toContainEqual({ type: "DISCLOSURE", disclosureCode: "DISCOVERY_OFFER_IDENTITY_ONLY" });
  });

  it("does not upgrade an existing Discovery working set on a follow-up turn", async () => {
    const current = baseState();
    current.workingSet = createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [{
        ...candidate("washer-offer", "3200"),
        canonicalModel: null,
        categoryId: "washing_machine",
        discovery: {
          supportLevel: "DISCOVERY",
          identityLevel: "OFFER_ONLY",
          identityKey: null,
          matchedPreferenceKeys: [],
          contradictedPreferenceKeys: [],
          rankVector: { eligibilityTier: 2, targetCoverage: 1, positiveCoverage: 0, negativeConflicts: 0, evidenceTier: 2, stockTier: 1, priceTieBreaker: "3200" },
        },
      }],
    });
    const host = new ConversationTurnDraftHost({
      turnId: "turn-discovery-follow-up",
      inputMessageIds: ["message-discovery-follow-up"],
      baseState: current,
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
    });
    const committed = await host.commitPlan({
      userIntentSummary: "ask for a direct purchase decision",
      ops: [{ opId: "inspect-discovery", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 1 }], fields: ["PRICE"] }],
      leftover: [],
    });
    await host.executeOperation(committed.plan.ops[0]!);
    const envelope = await host.publishReply({ outcome: "RECOMMENDATION", blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }], nextMoves: [] });
    expect(envelope.outcome).toBe("DISCOVERY");
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
    expect(envelope).toMatchObject({ outcome: "CLARIFICATION", addressedOpIds: ["fallback-clarification"] });
    expect(published).toMatchObject({
      allowedQuestionSlotIds: ["turn_rephrase"],
      state: { dialogue: { pendingClarification: { slotId: "turn_rephrase" } } },
    });
  });

  it("does not turn a pre-plan model failure into a Host-authored shopping plan", async () => {
    const plans: string[][] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-shopping-fallback",
      inputMessageIds: ["message-shopping-fallback"],
      inputMessageContents: ["先在美国查 Sony WH-1000XM5，最高 2600 元。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        research: async () => ({
          workingSet: createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [] }),
          result: { claims: [], disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"], publicResult: { candidates: [] } },
        }),
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([["REQUEST_CLARIFICATION"]]);
    expect(envelope).toMatchObject({
      outcome: "CLARIFICATION",
      blocks: [{ type: "QUESTION", slotId: "turn_rephrase" }],
    });
  });

  it("does not persist a prose-derived partial goal after model failure", async () => {
    const plans: Array<{ kinds: string[]; target: string | null }> = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-partial-shopping-fallback",
      inputMessageIds: ["message-partial-shopping-fallback"],
      inputMessageContents: ["想买一副通勤用的降噪耳机，预算先不限定。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
      onReplyValidated: async ({ state, plan }) => {
        plans.push({ kinds: plan.ops.map((operation) => operation.kind), target: state.goalRevision?.goal.target?.categoryId ?? null });
      },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(envelope.outcome).toBe("CLARIFICATION");
    expect(plans).toEqual([{ kinds: ["REQUEST_CLARIFICATION"], target: null }]);
  });

  it("does not execute prose-derived working-set mutations after a plan failure", async () => {
    const plans: string[][] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-follow-up-fallback",
      inputMessageIds: ["message-follow-up-fallback"],
      inputMessageContents: ["先把当前第二条排除，再只看新加坡，并检查剩余选择。"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      world: world(),
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([["REQUEST_CLARIFICATION"]]);
    expect(envelope.outcome).toBe("CLARIFICATION");
  });

  it("asks for the missing product instead of recovering a vague open target after model failure", async () => {
    let researchCalls = 0;
    const plans: string[][] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-vague-shopping-fallback",
      inputMessageIds: ["message-vague-shopping-fallback"],
      inputMessageContents: ["预算八千元以内，想在美国买个新的，但我还没说要买什么。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        research: async () => {
          researchCalls += 1;
          throw new Error("RESEARCH_NOT_EXPECTED");
        },
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([["REQUEST_CLARIFICATION"]]);
    expect(researchCalls).toBe(0);
    expect(envelope.outcome).toBe("CLARIFICATION");
  });

  it("does not replace a pending target clarification from raw prose after model failure", async () => {
    const current: ConversationState = {
      revision: 1,
      status: "OPEN",
      goalRevision: createGoalRevision(null, [
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US"] },
        { opId: "budget", kind: "GOAL_SET_BUDGET", source, budget: { amount: "30000", currency: "CNY" } },
      ], "prior-turn"),
      dialogue: {
        ...emptyDialogueState(),
        pendingClarification: { slotId: "target_product", askedByMessageId: "prior-turn" },
      },
      workingSet: null,
    };
    const plans: string[][] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-explicit-target-fallback",
      inputMessageIds: ["message-explicit-target-fallback"],
      inputMessageContents: ["我要的是 iPhone 16 Pro 256GB。"],
      baseState: current,
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        research: async () => ({
          workingSet: createWorkingSet({ version: 2, boundGoalVersion: 2, pool: [] }),
          result: { claims: [], disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"], publicResult: { candidates: [] } },
        }),
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([["REQUEST_CLARIFICATION"]]);
    expect(envelope.outcome).toBe("CLARIFICATION");
  });

  it("rejects an empty open-category proposal instead of inventing a target", async () => {
    const host = new ConversationTurnDraftHost({
      turnId: "turn-open-target-recovery",
      inputMessageIds: ["message-open-target-recovery"],
      inputMessageContents: ["在新加坡找一台十公斤左右的前置式洗衣机，不设预算。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      researchNeed: "INSUFFICIENT_COVERAGE",
      world: world(),
      loadRevision: async () => null,
    });
    await expect(host.commitPlan({ userIntentSummary: "recover open category", ops: [], leftover: [] })).rejects.toThrow();
  });

  it("persists trusted UI focus but does not infer inspection fields after a pre-plan failure", async () => {
    const plans: string[][] = [];
    const host = new ConversationTurnDraftHost({
      turnId: "turn-focused-inspection-fallback",
      inputMessageIds: ["message-focused-inspection-fallback"],
      inputMessageContents: ["这款现在确定有货吗？"],
      baseState: baseState(),
      researchNeed: "NOT_NEEDED",
      requiredFocusOfferRef: "offer-1",
      world: {
        ...world(),
        inspect: async () => ({ claims: [], disclosureCodes: ["STOCK_UNKNOWN"], publicResult: { unknownFields: ["STOCK"] } }),
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.opId)); },
    });
    const envelope = await host.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([["fallback-ui-focus", "fallback-clarification"]]);
    expect(envelope).toMatchObject({
      outcome: "CLARIFICATION",
      addressedOpIds: ["fallback-ui-focus", "fallback-clarification"],
      blocks: [{ type: "QUESTION", slotId: "turn_rephrase" }],
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
