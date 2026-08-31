import {
  createGoalRevision,
  createWorkingSet,
  emptyDialogueState,
  rejectWorkingSetOffers,
  validateClarificationAnswer,
  type CandidateView,
  type ConversationState,
} from "@interec/domain";
import { describe, expect, it } from "vitest";

import {
  ConversationTurnExecutor,
  type TurnExecutionSnapshot,
  type ShoppingDataPort,
} from "../src/index.js";

const source = { messageId: "base-message" };

function candidate(offerRef: string, amount: string): CandidateView {
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

function shoppingDataStub(inspected: string[][] = []): ShoppingDataPort {
  return {
    inspect: async (_operation, refs) => {
      inspected.push(refs);
      return { claims: [], disclosureCodes: [], publicResult: { inspectedOfferRefs: refs } };
    },
    inspectSearchCoverage: async () => ({ claims: [], disclosureCodes: [], publicResult: { found: false } }),
    search: async () => { throw new Error("SEARCH_NOT_EXPECTED"); },
  };
}

describe("deterministic turn turn executor", () => {
  it("executes historical coverage inspection without provider search and mandates its disclosure", async () => {
    let coverageInspections = 0;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-coverage",
      inputMessageIds: ["message-coverage"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: {
        ...shoppingDataStub(),
        inspectSearchCoverage: async () => {
          coverageInspections += 1;
          return {
            claims: [],
            disclosureCodes: ["SEARCH_COVERAGE_INCOMPLETE:SG"],
            publicResult: { found: true, failedMarkets: ["SG"] },
          };
        },
      },
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "inspect the previous search coverage",
      ops: [{ opId: "coverage", kind: "INSPECT_SEARCH_COVERAGE" }],
      leftover: [],
    });
    const receipt = await executor.executeOperation(committed.plan.ops[0]!);
    const envelope = await executor.publishReply({
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "CHECKED_PREMISE" }],
      nextMoves: [],
    });
    expect(coverageInspections).toBe(1);
    expect(receipt).toMatchObject({ toolName: "inspect_search_coverage", publicResult: { found: true } });
    expect(envelope.blocks[0]).toEqual({ type: "TRANSITION", text: "我先按现有证据核对这个前提。" });
    expect(envelope.blocks).toContainEqual({ type: "DISCLOSURE", disclosureCode: "SEARCH_COVERAGE_INCOMPLETE:SG" });
  });

  it("requires pi-agent to plan the exact durable UI focus before answering", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-focus",
      inputMessageIds: ["message-focus"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      requiredFocusOfferRef: "offer-2",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "answer without planning UI focus",
      ops: [{ opId: "inspect-wrong", kind: "INSPECT_WORKING_SET", referents: [{ kind: "OFFER_REF", offerRef: "offer-1" }], fields: ["STOCK"] }],
      leftover: [],
    }))
      .rejects.toMatchObject({ code: "UI_FOCUS_NOT_PLANNED" });
    await expect(executor.commitPlan({
      userIntentSummary: "focus exact candidate before answering",
      ops: [{ opId: "focus", kind: "SET_FOCUS", referent: { kind: "OFFER_REF", offerRef: "offer-2" } }],
      leftover: [],
    })).resolves.toMatchObject({ plan: { ops: [{ kind: "SET_FOCUS", referent: { offerRef: "offer-2" } }] } });
  });

  it("records bounded repair and rejects the second invalid proposal without state side effects", async () => {
    const reviews: Array<{ decision: string; proposalNumber: number; approvedPlan: unknown }> = [];
    let committed = false;
    let staged = false;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-plan-review-budget",
      inputMessageIds: ["message-plan-review-budget"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      requiredFocusOfferRef: "offer-2",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onPlanReviewed: async (observation) => {
        reviews.push({
          decision: observation.review.decision,
          proposalNumber: observation.proposalNumber,
          approvedPlan: observation.approvedPlan,
        });
      },
      onPlanCommitted: async () => { committed = true; },
      onDraftChanged: async () => { staged = true; },
    });
    const invalidProposal = {
      userIntentSummary: "inspect the wrong focused item",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET" as const, referents: [{ kind: "OFFER_REF" as const, offerRef: "offer-1" }], fields: ["PRICE" as const] }],
      leftover: [],
    };
    await expect(executor.commitPlan(invalidProposal)).rejects.toMatchObject({ review: { decision: "REPAIR_REQUIRED" } });
    await expect(executor.commitPlan(invalidProposal)).rejects.toMatchObject({ review: { decision: "REJECTED", failureOwner: "SYSTEM" } });
    expect(reviews).toEqual([
      { decision: "REPAIR_REQUIRED", proposalNumber: 1, approvedPlan: null },
      { decision: "REJECTED", proposalNumber: 2, approvedPlan: null },
    ]);
    expect(committed).toBe(false);
    expect(staged).toBe(false);
  });

  it("discards model provenance attached to turn actions", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-shopping-data-provenance",
      inputMessageIds: ["message-shopping-data-provenance"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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

  it("discards unsupported SearchGoalSnapshot values and normalizes an unstated condition to ANY", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-source-support",
      inputMessageIds: ["message-source-support"],
      inputMessageContents: ["想买一款通勤用的降噪耳机"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "headphones for commuting",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
        },
        { opId: "invented-budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "1000", currency: "CNY" } },
        { opId: "ask-budget", kind: "REQUEST_CLARIFICATION", clarification: { kind: "BUDGET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "BUDGET_UNDEFINED" },
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
      { opId: "ask-budget", kind: "REQUEST_CLARIFICATION", clarification: { kind: "BUDGET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "BUDGET_UNDEFINED" },
    ]);
  });

  it("accepts a target answer as contextual evidence instead of requiring the answer to repeat the question's wording", async () => {
    const current: ConversationState = {
      revision: 1,
      status: "OPEN",
      goalRevision: null,
      dialogue: {
        ...emptyDialogueState(),
        pendingClarification: {
          clarificationId: "target-question",
          clarification: { kind: "TARGET_PRODUCT", interpretations: ["fresh fruit", "electronics"] },
          askedByMessageId: "prior-turn",
        },
      },
      workingSet: null,
    };
    const answer = validateClarificationAnswer(current.dialogue, "target-question", { type: "TEXT", text: "fresh fruit, not electronics, in the US" });
    const executor = new ConversationTurnExecutor({
      turnId: "turn-target-answer-source",
      inputMessageIds: ["message-target-answer-source"],
      inputMessageContents: ["fresh fruit, not electronics, in the US"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      clarificationAnswer: answer,
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "resolve the target",
      ops: [{
        opId: "target",
        kind: "GOAL_SET_TARGET",
        sourceMessageOrdinal: 0,
        target: { categoryId: "apple_fruit", targetText: "apple", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "GOAL_SET_TARGET",
        source: { messageId: "message-target-answer-source" },
        target: expect.objectContaining({ categoryId: "apple_fruit", targetText: "apple" }),
      }),
    ]));
  });

  it("does not let contextual grounding turn an unresolved target answer into a product goal", async () => {
    const current: ConversationState = {
      revision: 1,
      status: "OPEN",
      goalRevision: null,
      dialogue: {
        ...emptyDialogueState(),
        pendingClarification: {
          clarificationId: "target-question-open",
          clarification: { kind: "TARGET_PRODUCT", interpretations: ["fresh fruit", "electronics"] },
          askedByMessageId: "prior-turn",
        },
      },
      workingSet: null,
    };
    const answer = validateClarificationAnswer(current.dialogue, "target-question-open", { type: "TEXT", text: "I don't know what to buy yet" });
    const executor = new ConversationTurnExecutor({
      turnId: "turn-unresolved-target-answer",
      inputMessageIds: ["message-unresolved-target-answer"],
      inputMessageContents: ["I don't know what to buy yet"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      clarificationAnswer: answer,
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "target is still unresolved",
      ops: [{
        opId: "invented-target",
        kind: "GOAL_SET_TARGET",
        sourceMessageOrdinal: 0,
        target: { categoryId: "laptop", targetText: "laptop", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      }],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_GOAL_TARGET_SOURCE" })]),
      },
    });
  });

  it("keeps literal source grounding strict outside a target-clarification answer", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-unsupported-direct-target",
      inputMessageIds: ["message-unsupported-direct-target"],
      inputMessageContents: ["My budget is 500 dollars"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "budget only",
      ops: [{
        opId: "invented-target",
        kind: "GOAL_SET_TARGET",
        sourceMessageOrdinal: 0,
        target: { categoryId: "laptop", targetText: "laptop", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      }],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_GOAL_TARGET_SOURCE" })]),
      },
    });
  });

  it("requires an explicit budget to be preserved even when the same turn asks a target clarification", async () => {
    const message = "I want to buy Mercury with a budget of 500 USD";
    const executor = new ConversationTurnExecutor({
      turnId: "turn-budget-before-target-clarification",
      inputMessageIds: ["message-budget-before-target-clarification"],
      inputMessageContents: [message],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const clarification = {
      opId: "clarify-target",
      kind: "REQUEST_CLARIFICATION" as const,
      sourceMessageOrdinal: 0,
      clarification: { kind: "TARGET_PRODUCT" as const, interpretations: ["Mercury brand product", "the chemical element mercury"] },
      uncertainty: { type: "INTENT_AMBIGUITY" as const, userResolvable: true as const },
      reasonCode: "TARGET_PRODUCT_AMBIGUOUS",
    };
    await expect(executor.commitPlan({
      userIntentSummary: "clarify the ambiguous target",
      ops: [clarification],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: expect.arrayContaining([expect.objectContaining({ code: "EXPLICIT_BUDGET_NOT_PLANNED" })]),
      },
    });

    const committed = await executor.commitPlan({
      userIntentSummary: "retain the budget and clarify the ambiguous target",
      ops: [
        {
          opId: "set-budget",
          kind: "GOAL_SET_BUDGET",
          sourceMessageOrdinal: 0,
          budget: { amount: "500", currency: "USD" },
        },
        clarification,
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "GOAL_SET_BUDGET", budget: { amount: "500", currency: "USD" } }),
      expect.objectContaining({ kind: "REQUEST_CLARIFICATION", clarification: expect.objectContaining({ kind: "TARGET_PRODUCT" }) }),
    ]));
  });

  it("reports all known-field omissions together so one bounded repair can retain target and budget", async () => {
    const message = "想买头戴式耳机，预算 3000 元。";
    const executor = new ConversationTurnExecutor({
      turnId: "turn-aggregate-known-fields",
      inputMessageIds: ["message-aggregate-known-fields"],
      inputMessageContents: [message],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "ask which headphone product",
      ops: [{
        opId: "clarify-target",
        kind: "REQUEST_CLARIFICATION",
        sourceMessageOrdinal: 0,
        clarification: { kind: "TARGET_PRODUCT", interpretations: ["头戴式降噪耳机", "头戴式开放耳机"] },
        uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true },
        reasonCode: "TARGET_PRODUCT_AMBIGUOUS",
      }],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "EXPLICIT_BUDGET_NOT_PLANNED" }),
          expect.objectContaining({ code: "EXPLICIT_REGISTERED_TARGET_NOT_PLANNED" }),
        ]),
      },
    });

    const committed = await executor.commitPlan({
      userIntentSummary: "retain the known headphone target and budget, then ask for market",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3000", currency: "CNY" } },
        {
          opId: "ask-market",
          kind: "REQUEST_CLARIFICATION",
          clarification: { kind: "PURCHASE_MARKET" },
          uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
          reasonCode: "PURCHASE_MARKET_REQUIRED",
        },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual([
      "GOAL_SET_TARGET",
      "GOAL_SET_BUDGET",
      "REQUEST_CLARIFICATION",
    ]);
  });

  it("normalizes Chinese budget numerals before reviewing known-field retention", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-chinese-budget",
      inputMessageIds: ["message-chinese-budget"],
      inputMessageContents: ["预算一万二千元，想在新加坡买东西，但还没决定具体买什么。"],
      baseState: {
        revision: 0,
        status: "OPEN",
        goalRevision: null,
        dialogue: emptyDialogueState(),
        workingSet: null,
      },
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "retain the market and clarify the product",
      ops: [
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["SG"] },
        {
          opId: "target-question",
          kind: "REQUEST_CLARIFICATION",
          clarification: { kind: "TARGET_PRODUCT" },
          uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
          reasonCode: "TARGET_PRODUCT_REQUIRED",
        },
      ],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "EXPLICIT_BUDGET_NOT_PLANNED", observed: expect.objectContaining({ amount: "12000" }) }),
        ]),
      },
    });
  });

  it("requires an explicit resolution operation when natural language answers a pending clarification", async () => {
    const current = baseState();
    current.dialogue.pendingClarification = {
      clarificationId: "pending-market",
      clarification: { kind: "PURCHASE_MARKET" },
      askedByMessageId: "assistant-market-question",
    };
    const snapshots: TurnExecutionSnapshot[] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-natural-market-answer",
      inputMessageIds: ["message-natural-market-answer"],
      inputMessageContents: ["美国和新加坡都看看。"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
    });
    const marketOperation = {
      opId: "set-markets",
      kind: "GOAL_SET_RETRIEVAL_MARKETS" as const,
      sourceMessageOrdinal: 0,
      markets: ["US", "SG"],
    };
    await expect(executor.commitPlan({
      userIntentSummary: "apply the answered market scope",
      ops: [marketOperation],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "PENDING_CLARIFICATION_RESOLUTION_NOT_PLANNED" }),
        ]),
      },
    });

    const committed = await executor.commitPlan({
      userIntentSummary: "resolve the pending market question and apply its answer",
      ops: [
        {
          opId: "resolve-market",
          kind: "RESOLVE_CLARIFICATION",
          clarificationId: "pending-market",
          clarification: { kind: "PURCHASE_MARKET" },
          outcome: "ANSWERED",
        },
        marketOperation,
      ],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
    expect(snapshots.at(-1)?.state.dialogue.pendingClarification).toBeNull();
  });

  it("grounds an open-category target in source text and removes explicit no-budget placeholders", async () => {
    const message = "I want a front load washing machine in US with no budget";
    const executor = new ConversationTurnExecutor({
      turnId: "turn-open-no-budget",
      inputMessageIds: ["message-open-no-budget"],
      inputMessageContents: [message],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
        { opId: "ask-budget", kind: "REQUEST_CLARIFICATION", clarification: { kind: "BUDGET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "BUDGET_UNDEFINED" },
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
    let reviewedKinds: string[] = [];
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onPlanReviewed: async ({ reviewedPlan }) => { reviewedKinds = reviewedPlan.ops.map((operation) => operation.kind); },
    });
    await expect(executor.commitPlan({
      userIntentSummary: "compare a stated model in two markets",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } },
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["美国", "新加坡"] },
      ],
      leftover: [],
    })).rejects.toMatchObject({ code: "TARGET_CLARIFICATION_REQUIRED" });
    expect(reviewedKinds).toEqual(["GOAL_SET_BUDGET", "GOAL_SET_RETRIEVAL_MARKETS"]);
  });

  it("does not invent a market from prose when the semantic proposal omits it", async () => {
    let reviewedKinds: string[] = [];
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onPlanReviewed: async ({ reviewedPlan }) => { reviewedKinds = reviewedPlan.ops.map((operation) => operation.kind); },
    });
    await expect(executor.commitPlan({
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
    })).rejects.toMatchObject({ code: "PURCHASE_MARKET_CLARIFICATION_REQUIRED" });
    expect(reviewedKinds).toEqual(["GOAL_SET_TARGET", "GOAL_SET_BUDGET"]);
  });

  it("rebinds proposed batch values to the message that actually supports their provenance", async () => {
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { opId: "target", source: { messageId: "message-correction" } },
      { opId: "budget", source: { messageId: "message-original" } },
      { opId: "market", source: { messageId: "message-original" } },
      { opId: "search", kind: "SEARCH_OFFERS" },
    ]);
  });

  it("rejects omitted superseding effects instead of silently adding or discarding them", async () => {
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "consume the complete superseding batch",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: { categoryId: "headphones", canonicalModel: "WH1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
        },
        { opId: "old-market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["SG"] },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "GOAL_BECAME_SEARCH_READY" },
      ],
      leftover: [],
    })).rejects.toMatchObject({
      review: {
        decision: "REPAIR_REQUIRED",
        violations: [{ code: "EXPLICIT_BUDGET_NOT_PLANNED" }],
      },
    });
  });

  it("rejects an empty semantic proposal instead of reparsing a message batch", async () => {
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({ userIntentSummary: "consume a superseding scope correction", ops: [], leftover: [] }))
      .rejects.toThrow();
  });

  it("does not infer a corrected target when the semantic proposal omits it", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-recover-correction",
      inputMessageIds: ["message-recover-correction"],
      inputMessageContents: ["不是 XM5，我说错了，是 Sony WH-1000XM4。"],
      baseState: baseState(),
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "correct the target model and search again",
      ops: [{ opId: "search-corrected", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{ opId: "search-corrected", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" }]);
  });

  it("binds a yuan budget to CNY instead of trusting a model-invented currency", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-budget-currency",
      inputMessageIds: ["message-budget-currency"],
      inputMessageContents: ["预算 2500 元，比较美国和新加坡"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "set the stated budget",
      ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CAD" } }],
      leftover: [],
    });
    expect(committed.plan.ops[0]).toMatchObject({ kind: "GOAL_SET_BUDGET", budget: { amount: "2500", currency: "CNY" } });
  });

  it("limits ordinal rejection to the explicitly named displayed rank", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-ordinal-reject",
      inputMessageIds: ["message-ordinal-reject"],
      inputMessageContents: ["只看新加坡，而且不要第二个"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
        { opId: "quantity-question", kind: "REQUEST_CLARIFICATION", clarification: { kind: "QUANTITY" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "quantity_requested" },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "GOAL_BECAME_SEARCH_READY" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual([
      "GOAL_SET_TARGET",
      "GOAL_SET_RETRIEVAL_MARKETS",
      "GOAL_SET_BUDGET",
      "SEARCH_OFFERS",
    ]);
  });

  it("binds current-last rejection after applying an earlier rejection in the same plan", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-sequential-reject",
      inputMessageIds: ["message-sequential-reject"],
      inputMessageContents: ["先不要第一条，然后把现在最后一条也排除。"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
    const executor = new ConversationTurnExecutor({
      turnId: "turn-restore-and-inspect",
      inputMessageIds: ["message-restore-and-inspect"],
      inputMessageContents: ["把刚才不要的那条恢复，再说说它现在的价格。"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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

  it("maps an offer-specific SearchGoalSnapshot restore onto the rejected working set", async () => {
    const current = baseState();
    current.workingSet = rejectWorkingSetOffers(current.workingSet!, ["offer-1", "offer-3"]);
    const executor = new ConversationTurnExecutor({
      turnId: "turn-goal-offer-restore",
      inputMessageIds: ["message-goal-offer-restore"],
      inputMessageContents: ["只撤销最近那次排除，第一条仍然不要。"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
    const executor = new ConversationTurnExecutor({
      turnId: "turn-empty-display-restore",
      inputMessageIds: ["message-empty-display-restore"],
      inputMessageContents: ["只撤销最近那次排除。"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
    const executor = new ConversationTurnExecutor({
      turnId: "turn-refresh-recovery",
      inputMessageIds: ["message-refresh-recovery"],
      inputMessageContents: ["范围扩大到美国和新加坡，并刷新一下当前报价。"],
      baseState: baseState(),
      searchNeed: "STALE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({ userIntentSummary: "expand markets and refresh", ops: [], leftover: [] })).rejects.toThrow();
  });

  it("enriches an exact smartphone model from source text and drops redundant storage constraints", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-exact-model",
      inputMessageIds: ["message-exact-model"],
      inputMessageContents: ["想买 iPhone 16 Pro 256GB 新机"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
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
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
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
      { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
    ]);
  });

  it("drops brand and model constraints already represented by a registered target", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-redundant-identity-constraints",
      inputMessageIds: ["message-redundant-identity-constraints"],
      inputMessageContents: ["找 Sony WH-1000XM4 耳机"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "set an exact target without duplicate validation rules",
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
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual(["GOAL_SET_TARGET", "SEARCH_OFFERS"]);
  });

  it("rejects a generic rephrase instead of replacing it with a prose-derived capacity correction", async () => {
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
    const executor = new ConversationTurnExecutor({
      turnId: "turn-capacity-correction",
      inputMessageIds: ["message-capacity-correction"],
      inputMessageContents: ["容量改成 256GB，其他条件保持不变。"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "correct only the capacity",
      ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "TURN_REPHRASE" }, uncertainty: { type: "INTENT_AMBIGUITY", userResolvable: true }, reasonCode: "MODEL_UNCERTAIN" }],
      leftover: [],
    })).rejects.toMatchObject({
      review: { decision: "REPAIR_REQUIRED", violations: [{ code: "GENERIC_REPHRASE_NOT_ACTIONABLE" }] },
    });
  });

  it("normalizes an explicit undo of the current revision to its direct predecessor", async () => {
    const current = baseState();
    current.revision = 2;
    const previous = baseState();
    previous.revision = 1;
    const loaded: number[] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-normalize-undo",
      inputMessageIds: ["message-normalize-undo"],
      inputMessageContents: ["把上一次改动整个撤销。"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async (revision) => {
        loaded.push(revision);
        return revision === 1 ? previous : null;
      },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "undo the last change",
      ops: [{ opId: "undo", kind: "UNDO_REVISION", revision: 2 }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([{ opId: "undo", kind: "UNDO_REVISION", revision: 1 }]);
    await executor.executeOperation(committed.plan.ops[0]!);
    expect(loaded).toEqual([1]);
  });

  it("rejects empty-working-set candidate operations before they become false ambiguity", async () => {
    const current = baseState();
    current.workingSet = createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [] });
    const executor = new ConversationTurnExecutor({
      turnId: "turn-empty-referent",
      inputMessageIds: ["message-empty-referent"],
      inputMessageContents: ["第二个和第一个差在哪？"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "compare missing candidates",
      ops: [{
        opId: "inspect",
        kind: "INSPECT_WORKING_SET",
        referents: [{ kind: "DISPLAY_RANK", rank: 1 }, { kind: "DISPLAY_RANK", rank: 2 }],
        fields: ["PRICE"],
      }],
      leftover: [],
    })).rejects.toMatchObject({ code: "CANDIDATE_SET_REQUIRED" });
  });

  it("clears an obsolete referent clarification when a new SearchGoalSnapshot instruction supersedes it", async () => {
    const current = baseState();
    current.dialogue = {
      ...current.dialogue,
      pendingClarification: { clarification: { kind: "CANDIDATE_REFERENT", contextRef: "inspect" }, askedByMessageId: "previous-turn" },
    };
    const snapshots: TurnExecutionSnapshot[] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-new-goal",
      inputMessageIds: ["message-new-goal"],
      inputMessageContents: ["只看美国"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "narrow market",
      ops: [{ opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] }],
      leftover: [],
    });
    await executor.executeOperation(committed.plan.ops[0]!);
    expect(snapshots.at(-1)?.state.dialogue.pendingClarification).toBeNull();
  });

  it("stabilizes all referents against the observation snapshot before ordered mutations", async () => {
    const inspected: string[][] = [];
    const snapshots: TurnExecutionSnapshot[] = [];
    let published: Parameters<NonNullable<ConstructorParameters<typeof ConversationTurnExecutor>[0]["onReplyValidated"]>>[0] | null = null;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-2",
      inputMessageIds: ["message-2"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(inspected),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
      onReplyValidated: async (value) => { published = value; },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "reject second, prefer cheaper, inspect original third",
      ops: [
        { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
        { opId: "sort", kind: "SORT_WORKING_SET_BY_PRICE", preferenceKey: "price:lower" },
        { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 3 }], fields: ["PRICE"] },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toMatchObject([
      { opId: "reject", referents: [{ kind: "OFFER_REF", offerRef: "offer-2" }] },
      { opId: "sort" },
      { opId: "inspect", referents: [{ kind: "OFFER_REF", offerRef: "offer-3" }] },
    ]);
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
    expect(inspected).toEqual([["offer-3"]]);
    await executor.publishReply({
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
    const snapshots: TurnExecutionSnapshot[] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-generic-rerank",
      inputMessageIds: ["message-generic-rerank"],
      inputMessageContents: ["更偏好低噪音，基于当前候选重新排序"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "prefer lower noise and rerank current candidates",
      ops: [
        {
          opId: "preference",
          kind: "GOAL_UPSERT_PREFERENCE",
          sourceMessageOrdinal: 0,
          preference: { key: "noise_level", value: "low", weight: 0.7 },
        },
        { opId: "sort", kind: "SORT_WORKING_SET_BY_PRICE", preferenceKey: "noise_level" },
      ],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
    expect(snapshots.at(-1)?.state.workingSet?.displayOfferRefs).toEqual(["offer-1", "offer-2", "offer-3"]);
    expect(snapshots.at(-1)?.state.goalRevision?.goal.preferences).toMatchObject([
      { key: "noise_level", value: "low", weight: 0.7 },
    ]);
  });

  it("binds goal operation ordinals and creates one monotone goal version for the whole turn", async () => {
    let finalSnapshot: TurnExecutionSnapshot | null = null;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-budget",
      inputMessageIds: ["real-user-message"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { finalSnapshot = snapshot; },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "change budget and market",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] },
      ],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
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

  it("enforces the zero-provider policy before staging search", async () => {
    let planCommitted = false;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-policy",
      inputMessageIds: ["message-policy"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onPlanCommitted: async () => { planCommitted = true; },
    });
    await expect(executor.commitPlan({
      userIntentSummary: "unnecessary refresh",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "NOT_NEEDED" }],
      leftover: [],
    })).rejects.toMatchObject({ code: "UNNECESSARY_PROVIDER_SEARCH" });
    expect(planCommitted).toBe(false);
  });

  it("does not label incomplete search evidence as a verified no-match", async () => {
    const current = baseState();
    current.workingSet = null;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-no-match",
      inputMessageIds: ["message-no-match"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        search: async () => ({
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
    const committed = await executor.commitPlan({
      userIntentSummary: "search the current goal",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    });
    await executor.executeOperation(committed.plan.ops[0]!);
    const envelope = await executor.publishReply({
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "SEARCH_COMPLETED" }],
      nextMoves: [],
    });
    expect(envelope).toMatchObject({
      outcome: "CHAT",
      addressedOpIds: ["search"],
      blocks: [
        { type: "TRANSITION", text: "我已完成本轮检索和证据校验。" },
        { type: "DISCLOSURE", disclosureCode: "UNVERIFIED_RESULTS_NOT_RECOMMENDED" },
      ],
    });
  });

  it("uses NO_MATCH only when completed search evidence has no admitted candidates", async () => {
    const current = baseState();
    current.workingSet = null;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-verified-no-match",
      inputMessageIds: ["message-verified-no-match"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        search: async () => ({
          workingSet: createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [] }),
          result: { claims: [], disclosureCodes: [], publicResult: { candidates: [] } },
        }),
      },
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "search the current goal",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    });
    await executor.executeOperation(committed.plan.ops[0]!);
    const envelope = await executor.publishReply({
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "SEARCH_COMPLETED" }],
      nextMoves: [],
    });
    expect(envelope.outcome).toBe("NO_MATCH");
  });

  it("labels listing-level search results as search-only even when the model proposes a recommendation", async () => {
    const current = baseState();
    current.workingSet = null;
    const searchResultsCandidate: CandidateView = {
      ...candidate("laptop-offer", "5593"),
      title: "Lightweight Laptop 14",
      canonicalModel: null,
      categoryId: "laptop",
      ranking: {
        validationMode: "SEARCH_ONLY",
        identityResolution: "LISTING_LEVEL",
        identityKey: null,
        matchedPreferenceKeys: ["portable"],
        contradictedPreferenceKeys: [],
        rankVector: { eligibilityTier: 2, targetCoverage: 1, positiveCoverage: 1, negativeConflicts: 0, evidenceTier: 2, stockTier: 1, priceTieBreaker: "5593" },
      },
    };
    const executor = new ConversationTurnExecutor({
      turnId: "turn-search-results",
      inputMessageIds: ["message-search-results"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        search: async () => ({
          workingSet: createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [searchResultsCandidate] }),
          result: { claims: [], disclosureCodes: ["LISTING_LEVEL_IDENTITY_ONLY"], publicResult: { candidates: [searchResultsCandidate] } },
        }),
      },
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "discover laptops",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    });
    await executor.executeOperation(committed.plan.ops[0]!);
    const envelope = await executor.publishReply({ outcome: "CHAT", blocks: [{ type: "TRANSITION", transitionCode: "SEARCH_COMPLETED" }], nextMoves: [] });
    expect(envelope.outcome).toBe("SEARCH_RESULTS");
    expect(envelope.blocks).toContainEqual({ type: "DISCLOSURE", disclosureCode: "LISTING_LEVEL_IDENTITY_ONLY" });
  });

  it("does not upgrade an existing Search-only working set on a follow-up turn", async () => {
    const current = baseState();
    current.workingSet = createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [{
        ...candidate("washer-offer", "3200"),
        canonicalModel: null,
        categoryId: "washing_machine",
        ranking: {
          validationMode: "SEARCH_ONLY",
          identityResolution: "LISTING_LEVEL",
          identityKey: null,
          matchedPreferenceKeys: [],
          contradictedPreferenceKeys: [],
          rankVector: { eligibilityTier: 2, targetCoverage: 1, positiveCoverage: 0, negativeConflicts: 0, evidenceTier: 2, stockTier: 1, priceTieBreaker: "3200" },
        },
      }],
    });
    const executor = new ConversationTurnExecutor({
      turnId: "turn-search-results-follow-up",
      inputMessageIds: ["message-search-results-follow-up"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "ask for a direct purchase decision",
      ops: [{ opId: "inspect-search-results", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 1 }], fields: ["PRICE"] }],
      leftover: [],
    });
    await executor.executeOperation(committed.plan.ops[0]!);
    const envelope = await executor.publishReply({ outcome: "RECOMMENDATION", blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }], nextMoves: [] });
    expect(envelope.outcome).toBe("SEARCH_RESULTS");
  });

  it("keeps one explicit question when model narration repeats the clarification", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-question",
      inputMessageIds: ["message-question"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "ask for budget",
      ops: [{ opId: "ask-budget", kind: "REQUEST_CLARIFICATION", clarification: { kind: "BUDGET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "MISSING_BUDGET" }],
      leftover: [],
    });
    await executor.executeOperation(committed.plan.ops[0]!);
    const envelope = await executor.publishReply({
      outcome: "CLARIFICATION",
      blocks: [
        { type: "TRANSITION", transitionCode: "STATE_UPDATED" },
        { type: "QUESTION", clarification: { kind: "BUDGET" } },
      ],
      nextMoves: [],
    });
    expect(envelope.blocks).toEqual([{
      type: "QUESTION",
      clarificationId: "turn-question:ask-budget",
      clarification: { kind: "BUDGET" },
      wording: "预算大概是多少？",
      rationale: expect.stringContaining("预算"),
      responseSpec: expect.objectContaining({ inputMode: "FREE_TEXT", allowSkip: true, examples: ["3000 元以内", "预算不限"] }),
    }]);
  });

  it("preserves purchase-market semantics across policy, execution, and reply materialization", async () => {
    const current = baseState();
    current.goalRevision = createGoalRevision(null, [{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
    }], "base-turn");
    current.workingSet = null;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-missing-market",
      inputMessageIds: ["message-missing-market"],
      inputMessageContents: ["想买头戴式耳机，预算 3000 元以内。"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "recommend headphones under CNY 3000",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3000", currency: "CNY" } },
        { opId: "ask-market", kind: "REQUEST_CLARIFICATION", clarification: { kind: "PURCHASE_MARKET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "MISSING_REQUIRED_GOAL_FIELD" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([
      expect.objectContaining({ opId: "budget", kind: "GOAL_SET_BUDGET", budget: { amount: "3000", currency: "CNY" } }),
      {
        opId: "ask-market",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "PURCHASE_MARKET" },
        uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
        reasonCode: "MISSING_REQUIRED_GOAL_FIELD",
      },
    ]);
    await executor.executeOperation(committed.plan.ops[0]!);
    await executor.executeOperation(committed.plan.ops[1]!);
    const envelope = await executor.publishReply({
      outcome: "CLARIFICATION",
      blocks: [{ type: "QUESTION", clarification: { kind: "PURCHASE_MARKET" } }],
      nextMoves: [],
    });
    expect(envelope.blocks).toEqual([expect.objectContaining({
      type: "QUESTION",
      clarification: { kind: "PURCHASE_MARKET" },
      wording: expect.stringContaining("两边都比较"),
    })]);
    expect(envelope.blocks[0]).not.toMatchObject({ wording: expect.stringContaining("关键选购条件") });
  });

  it("resolves a server-validated market option, clears the question, and continues to search", async () => {
    const current = baseState();
    current.goalRevision = createGoalRevision(null, [{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
    }], "base-turn");
    current.workingSet = null;
    current.dialogue.pendingClarification = {
      clarificationId: "clarification-market",
      clarification: { kind: "PURCHASE_MARKET" },
      askedByMessageId: "assistant-market",
    };
    const answer = validateClarificationAnswer(current.dialogue, "clarification-market", { type: "OPTION", optionId: "US_SG" });
    let searchCalls = 0;
    const snapshots: TurnExecutionSnapshot[] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-answer-market",
      inputMessageIds: ["message-answer-market"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      clarificationAnswer: answer,
      shoppingData: {
        ...shoppingDataStub(),
        search: async () => {
          searchCalls += 1;
          return { workingSet: createWorkingSet({ version: 2, boundGoalVersion: 2, pool: [] }), result: { claims: [], disclosureCodes: [], publicResult: {} } };
        },
      },
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { snapshots.push(snapshot); },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "apply the selected purchase markets",
      ops: [
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: answer.goalValue as string[] },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "GOAL_BECAME_SEARCH_READY" },
      ],
      leftover: [],
    });
    expect(committed.plan.ops.map((operation) => operation.kind)).toEqual(["RESOLVE_CLARIFICATION", "GOAL_SET_RETRIEVAL_MARKETS", "SEARCH_OFFERS"]);
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
    expect(searchCalls).toBe(1);
    expect(snapshots.at(-1)?.state.dialogue).toMatchObject({
      pendingClarification: null,
      clarificationHistory: [{ clarification: { kind: "PURCHASE_MARKET" }, outcome: "ANSWERED" }],
    });
  });

  it("turns a validated market skip into search-then-refine without repeating the question", async () => {
    const current = baseState();
    current.goalRevision = createGoalRevision(null, [{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
    }], "base-turn");
    current.workingSet = null;
    current.dialogue.pendingClarification = {
      clarificationId: "clarification-market-skip",
      clarification: { kind: "PURCHASE_MARKET" },
      askedByMessageId: "assistant-market",
    };
    const answer = validateClarificationAnswer(current.dialogue, "clarification-market-skip", { type: "SKIP" });
    const scopes: string[][] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-skip-market",
      inputMessageIds: ["message-skip-market"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      clarificationAnswer: answer,
      shoppingData: {
        ...shoppingDataStub(),
        search: async (operation) => {
          scopes.push(operation.marketScope ?? []);
          return {
            workingSet: createWorkingSet({ version: 2, boundGoalVersion: 1, pool: [] }),
            result: { claims: [], disclosureCodes: operation.assumptionDisclosureCodes ?? [], publicResult: {} },
          };
        },
      },
      loadRevision: async () => null,
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "skip market and continue",
      ops: [{
        opId: "continue-search",
        kind: "SEARCH_OFFERS",
        reasonCode: "CLARIFICATION_SKIPPED_SEARCH_THEN_REFINE",
        marketScope: ["US", "SG"],
        assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
      }],
      leftover: [],
    });
    expect(committed.plan.ops).toEqual([
      expect.objectContaining({ kind: "RESOLVE_CLARIFICATION", outcome: "SKIPPED" }),
      expect.objectContaining({ kind: "SEARCH_OFFERS", marketScope: ["US", "SG"], assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"] }),
    ]);
    expect(committed.plan.ops.some((operation) => operation.kind === "REQUEST_CLARIFICATION")).toBe(false);
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
    expect(scopes).toEqual([["US", "SG"]]);
  });

  it("rejects an unknown clarification protocol value before it pollutes dialogue state", async () => {
    const executor = new ConversationTurnExecutor({
      turnId: "turn-unknown-clarification",
      inputMessageIds: ["message-unknown-clarification"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({
      userIntentSummary: "model invented a plausible slot",
      ops: [{ opId: "ask-invented", kind: "REQUEST_CLARIFICATION", slotId: "lifestyle_fit_index", reasonCode: "MODEL_SELECTED" }],
      leftover: [],
    } as never)).rejects.toThrowError(/Unknown clarification protocol value/);
    const envelope = await executor.fallbackReply("UNKNOWN_CLARIFICATION_SLOT", null, []);
    expect(envelope).toMatchObject({
      outcome: "DEGRADED",
      addressedOpIds: [],
      blocks: [{ type: "TRANSITION" }],
    });
  });

  it("publishes a system-owned degradation without creating a clarification plan", async () => {
    const plans: string[][] = [];
    let published: { allowedClarificationIds: string[]; state: ConversationState } | null = null;
    const executor = new ConversationTurnExecutor({
      turnId: "turn-fallback",
      inputMessageIds: ["message-fallback"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.opId)); },
      onReplyValidated: async (value) => { published = value; },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([]);
    expect(envelope).toMatchObject({ outcome: "DEGRADED", addressedOpIds: [], blocks: [{ type: "TRANSITION" }] });
    expect(published).toMatchObject({
      allowedClarificationIds: [],
      answerability: { mode: "DEGRADE", uncertaintyType: "SYSTEM_FAILURE", failureOwner: "SYSTEM", errorCode: "MODEL_PROTOCOL_FAILED" },
      state: { dialogue: { pendingClarification: null } },
    });
  });

  it("does not turn a pre-plan model failure into a executor-authored shopping plan", async () => {
    const plans: string[][] = [];
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        search: async () => ({
          workingSet: createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [] }),
          result: { claims: [], disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"], publicResult: { candidates: [] } },
        }),
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([]);
    expect(envelope).toMatchObject({
      outcome: "DEGRADED",
      blocks: [{ type: "TRANSITION" }],
    });
  });

  it("does not persist a prose-derived partial goal after model failure", async () => {
    const plans: Array<{ kinds: string[]; target: string | null }> = [];
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onReplyValidated: async ({ state, plan }) => {
        plans.push({ kinds: plan.ops.map((operation) => operation.kind), target: state.goalRevision?.goal.target?.categoryId ?? null });
      },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(envelope.outcome).toBe("DEGRADED");
    expect(plans).toEqual([{ kinds: [], target: null }]);
  });

  it("does not execute prose-derived working-set mutations after a plan failure", async () => {
    const plans: string[][] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-follow-up-fallback",
      inputMessageIds: ["message-follow-up-fallback"],
      inputMessageContents: ["先把当前第二条排除，再只看新加坡，并检查剩余选择。"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([]);
    expect(envelope.outcome).toBe("DEGRADED");
  });

  it("does not invent either a product or a clarification after model failure", async () => {
    let searchCalls = 0;
    const plans: string[][] = [];
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        search: async () => {
          searchCalls += 1;
          throw new Error("SEARCH_NOT_EXPECTED");
        },
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([]);
    expect(searchCalls).toBe(0);
    expect(envelope.outcome).toBe("DEGRADED");
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
        pendingClarification: { clarification: { kind: "TARGET_PRODUCT" }, askedByMessageId: "prior-turn" },
      },
      workingSet: null,
    };
    const plans: string[][] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-explicit-target-fallback",
      inputMessageIds: ["message-explicit-target-fallback"],
      inputMessageContents: ["我要的是 iPhone 16 Pro 256GB。"],
      baseState: current,
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: {
        inspect: async () => ({ claims: [], disclosureCodes: [], publicResult: {} }),
        search: async () => ({
          workingSet: createWorkingSet({ version: 2, boundGoalVersion: 2, pool: [] }),
          result: { claims: [], disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"], publicResult: { candidates: [] } },
        }),
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.kind)); },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([]);
    expect(envelope.outcome).toBe("DEGRADED");
  });

  it("rejects an empty open-category proposal instead of inventing a target", async () => {
    const executor = new ConversationTurnExecutor({
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
      searchNeed: "INSUFFICIENT_COVERAGE",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
    });
    await expect(executor.commitPlan({ userIntentSummary: "recover open category", ops: [], leftover: [] })).rejects.toThrow();
  });

  it("does not persist UI focus or infer inspection fields without an approved plan", async () => {
    const plans: string[][] = [];
    const executor = new ConversationTurnExecutor({
      turnId: "turn-focused-inspection-fallback",
      inputMessageIds: ["message-focused-inspection-fallback"],
      inputMessageContents: ["这款现在确定有货吗？"],
      baseState: baseState(),
      searchNeed: "NOT_NEEDED",
      requiredFocusOfferRef: "offer-1",
      shoppingData: {
        ...shoppingDataStub(),
        inspect: async () => ({ claims: [], disclosureCodes: ["STOCK_UNKNOWN"], publicResult: { unknownFields: ["STOCK"] } }),
      },
      loadRevision: async () => null,
      onPlanCommitted: async (plan) => { plans.push(plan.ops.map((operation) => operation.opId)); },
    });
    const envelope = await executor.fallbackReply("MODEL_PROTOCOL_FAILED", null, []);
    expect(plans).toEqual([]);
    expect(envelope).toMatchObject({
      outcome: "DEGRADED",
      addressedOpIds: [],
      blocks: [{ type: "TRANSITION" }],
    });
  });

  it("clears a prior generic recovery clarification when the next turn stages an actionable plan", async () => {
    const current = baseState();
    current.dialogue.pendingClarification = { clarification: { kind: "TURN_REPHRASE" }, askedByMessageId: "failed-turn" };
    let finalSnapshot: TurnExecutionSnapshot | null = null;
    const executor = new ConversationTurnExecutor({
      turnId: "recovery-turn",
      inputMessageIds: ["recovery-message"],
      baseState: current,
      searchNeed: "NOT_NEEDED",
      shoppingData: shoppingDataStub(),
      loadRevision: async () => null,
      onDraftChanged: async (snapshot) => { finalSnapshot = snapshot; },
    });
    const committed = await executor.commitPlan({
      userIntentSummary: "continue after a protocol fallback",
      ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
      leftover: [],
    });
    for (const operation of committed.plan.ops) await executor.executeOperation(operation);
    expect(finalSnapshot?.state.dialogue.pendingClarification).toBeNull();
  });
});
