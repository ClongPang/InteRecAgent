import { describe, expect, it } from "vitest";

import {
  createGoalRevision,
  createWorkingSet,
  emptyDialogueState,
  type CandidateView,
  type ConversationState,
} from "@interec/domain";
import {
  ConversationTurnExecutor,
  type TurnExecutionSnapshot,
  type TurnPlanProposal,
  type ShoppingDataPort,
} from "../src/index.js";

const source = { messageId: "seed-message" };

function offer(offerRef: string, market: string, amount: string): CandidateView {
  return {
    offerRef,
    title: `Sony WH-1000XM5 ${market} ${offerRef}`,
    canonicalModel: "WH-1000XM5",
    categoryId: "headphones",
    itemRole: "PRIMARY_PRODUCT",
    condition: "NEW",
    retrievalMarket: market,
    merchant: `Merchant ${offerRef}`,
    cnyAmount: amount,
    stock: "UNKNOWN",
    claimIds: [`claim-${offerRef}`],
  };
}

function seededState(revision = 1): ConversationState {
  const goalRevision = createGoalRevision(null, [
    { opId: "seed-target", kind: "GOAL_SET_TARGET", source, target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
    { opId: "seed-markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", source, markets: ["US", "SG"] },
  ], "seed-turn", revision);
  return {
    revision,
    status: "OPEN",
    goalRevision,
    dialogue: emptyDialogueState(),
    workingSet: createWorkingSet({
      version: revision,
      boundGoalVersion: goalRevision.version,
      pool: [offer("offer-1", "US", "2100"), offer("offer-2", "SG", "1900"), offer("offer-3", "US", "2300")],
    }),
  };
}

interface Result {
  state: ConversationState;
  providerCalls: number;
  inspected: string[][];
}

async function execute(
  baseState: ConversationState,
  proposal: TurnPlanProposal,
  options: { requiredFocusOfferRef?: string; revisions?: Map<number, ConversationState> } = {},
): Promise<Result> {
  let latest: TurnExecutionSnapshot | null = null;
  let providerCalls = 0;
  const inspected: string[][] = [];
  const shoppingData: ShoppingDataPort = {
    inspect: async (_operation, refs) => {
      inspected.push(refs);
      return { claims: [], disclosureCodes: [], publicResult: { offerRefs: refs } };
    },
    inspectSearchCoverage: async () => ({ claims: [], disclosureCodes: [], publicResult: { found: false } }),
    search: async (_operation, state) => {
      providerCalls += 1;
      const model = state.goalRevision?.goal.target?.canonicalModel ?? "UNKNOWN";
      const pool = [offer(`${model}-US`, "US", "2200"), offer(`${model}-SG`, "SG", "2050")]
        .map((candidate) => ({ ...candidate, canonicalModel: model }));
      return {
        workingSet: createWorkingSet({ version: state.revision, boundGoalVersion: state.goalRevision!.version, pool }),
        result: { claims: [], disclosureCodes: [], publicResult: { offerCount: pool.length } },
      };
    },
  };
  const executor = new ConversationTurnExecutor({
    turnId: `turn-${baseState.revision + 1}`,
    inputMessageIds: [`message-${baseState.revision + 1}`],
    baseState,
    searchNeed: baseState.workingSet ? "NOT_NEEDED" : "INSUFFICIENT_COVERAGE",
    shoppingData,
    loadRevision: async (revision) => options.revisions?.get(revision) ?? null,
    ...(options.requiredFocusOfferRef ? { requiredFocusOfferRef: options.requiredFocusOfferRef } : {}),
    onDraftChanged: async (snapshot) => { latest = snapshot; },
  });
  const committed = await executor.commitPlan(proposal);
  for (const operation of committed.plan.ops) await executor.executeOperation(operation);
  if (!latest) throw new Error("TRAJECTORY_DRAFT_MISSING");
  return { state: (latest as TurnExecutionSnapshot).state, providerCalls, inspected };
}

describe("approved offline conversational trajectories", () => {
  it("requires the agent plan to ask for the missing required search input and keeps the Conversation open", async () => {
    const base: ConversationState = { revision: 0, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet: null };
    const result = await execute(base, {
      userIntentSummary: "set category and ask purchase market",
      ops: [
        { opId: "target", kind: "GOAL_SET_TARGET", sourceMessageOrdinal: 0, target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
        { opId: "clarify", kind: "REQUEST_CLARIFICATION", clarification: { kind: "PURCHASE_MARKET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "MISSING_REQUIRED_GOAL_FIELD" },
      ],
      leftover: [],
    });
    expect(result.state).toMatchObject({ status: "OPEN", dialogue: { pendingClarification: { clarification: { kind: "PURCHASE_MARKET" } } } });
    expect(result.providerCalls).toBe(0);
  });

  it("resumes the same goal after clarification and researches once", async () => {
    const base = seededState();
    base.workingSet = null;
    base.dialogue.pendingClarification = { clarificationId: "clarification-budget", clarification: { kind: "BUDGET" }, askedByMessageId: "assistant-1" };
    const result = await execute(base, {
      userIntentSummary: "answer budget and search two markets",
      ops: [
        { opId: "resolve-clarification", kind: "RESOLVE_CLARIFICATION", clarificationId: "clarification-budget", clarification: { kind: "BUDGET" }, outcome: "ANSWERED" },
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } },
        { opId: "resolve", kind: "GOAL_RESOLVE_GAP", sourceMessageOrdinal: 0, slotId: "budget" },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" },
      ],
      leftover: [],
    });
    expect(result.state.goalRevision?.goal.budget?.amount).toBe("2500");
    expect(result.state.workingSet?.pool).toHaveLength(2);
    expect(result.providerCalls).toBe(1);
  });

  it("compares stable ranks from the existing WorkingSet with zero Provider calls", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "compare second and first",
      ops: [
        { opId: "compare", kind: "SET_COMPARISON", referents: [{ kind: "DISPLAY_RANK", rank: 2 }, { kind: "DISPLAY_RANK", rank: 1 }] },
        { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "COMPARISON" }], fields: ["PRICE", "STOCK"] },
      ],
      leftover: [],
    });
    expect(result.state.workingSet?.comparisonOfferRefs).toEqual(["offer-2", "offer-1"]);
    expect(result.inspected).toEqual([["offer-2", "offer-1"]]);
    expect(result.providerCalls).toBe(0);
  });

  it("executes reject, cheaper stance and third-item inspection in one ordered turn", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "reject second, prefer cheaper, ask original third",
      ops: [
        { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
        { opId: "stance", kind: "GOAL_UPSERT_PREFERENCE", sourceMessageOrdinal: 0, preference: { key: "price", value: "LOWER", weight: 1 } },
        { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 3 }], fields: ["PRICE"] },
      ],
      leftover: [],
    });
    expect(result.state.workingSet?.rejectedOfferRefs).toContain("offer-2");
    expect(result.inspected).toEqual([["offer-3"]]);
    expect(result.providerCalls).toBe(0);
  });

  it("refilters to one market without discarding the pool", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "only US",
      ops: [
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] },
        { opId: "refilter", kind: "REFILTER_WORKING_SET" },
      ],
      leftover: [],
    });
    expect(result.state.workingSet?.displayOfferRefs).toEqual(["offer-1", "offer-3"]);
    expect(result.state.workingSet?.pool).toHaveLength(3);
    expect(result.providerCalls).toBe(0);
  });

  it("corrects a target and replaces incompatible candidates through search", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "replace XM5 with XM4",
      ops: [
        { opId: "target", kind: "GOAL_SET_TARGET", sourceMessageOrdinal: 0, target: { categoryId: "headphones", canonicalModel: "WH-1000XM4", itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
        { opId: "search", kind: "SEARCH_OFFERS", reasonCode: "TARGET_CHANGED" },
      ],
      leftover: [],
    });
    expect(result.state.goalRevision?.goal.target?.canonicalModel).toBe("WH-1000XM4");
    expect(result.state.workingSet?.pool.every((candidate) => candidate.canonicalModel === "WH-1000XM4")).toBe(true);
    expect(result.providerCalls).toBe(1);
  });

  it("undo restores the exact earlier SearchGoalSnapshot and WorkingSet revision", async () => {
    const earlier = seededState(1);
    const changed = await execute(earlier, {
      userIntentSummary: "change budget",
      ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3000", currency: "CNY" } }],
      leftover: [],
    });
    const undone = await execute(changed.state, {
      userIntentSummary: "undo last revision",
      ops: [{ opId: "undo", kind: "UNDO_REVISION", revision: 1 }],
      leftover: [],
    }, { revisions: new Map([[1, earlier]]) });
    expect(undone.state.goalRevision).toEqual(earlier.goalRevision);
    expect(undone.state.workingSet).toEqual(earlier.workingSet);
  });

  it("binds the durable UI focus before inspecting that candidate", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "answer stock for UI-focused candidate",
      ops: [
        { opId: "focus", kind: "SET_FOCUS", referent: { kind: "OFFER_REF", offerRef: "offer-2" } },
        { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "FOCUS" }], fields: ["STOCK"] },
      ],
      leftover: [],
    }, { requiredFocusOfferRef: "offer-2" });
    expect(result.state.workingSet?.focusOfferRef).toBe("offer-2");
    expect(result.inspected).toEqual([["offer-2"]]);
  });

  it("restores rank and focus from a serialized snapshot without process memory", async () => {
    const restored = structuredClone(seededState());
    restored.workingSet!.focusOfferRef = "offer-2";
    restored.dialogue.focusOfferRef = "offer-2";
    const result = await execute(JSON.parse(JSON.stringify(restored)) as ConversationState, {
      userIntentSummary: "inspect second after refresh",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], fields: ["PRICE"] }],
      leftover: [],
    });
    expect(result.inspected).toEqual([["offer-2"]]);
    expect(result.providerCalls).toBe(0);
  });

  it("commits budget, market and rejection as one compound turn", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "budget 3000, SG only, reject second",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3000", currency: "CNY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["SG"] },
        { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
      ],
      leftover: [],
    });
    expect(result.state.goalRevision?.goal).toMatchObject({ budget: { amount: "3000" }, retrievalMarkets: ["SG"] });
    expect(result.state.workingSet?.rejectedOfferRefs).toContain("offer-2");
    expect(result.providerCalls).toBe(0);
  });

  it("explains only from current evidence and leaves unsupported warranty to the reply layer", async () => {
    const result = await execute(seededState(), {
      userIntentSummary: "explain recommendation and ask warranty",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 1 }], fields: ["RANKING_REASON", "WARRANTY"] }],
      leftover: [],
    });
    expect(result.inspected).toEqual([["offer-1"]]);
    expect(result.providerCalls).toBe(0);
  });
});
