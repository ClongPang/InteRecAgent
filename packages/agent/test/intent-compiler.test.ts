import { describe, expect, it } from "vitest";

import type { ConversationState } from "@interec/domain";

import { compileTurnIntent } from "../src/intent-compiler.js";

function emptyState(): ConversationState {
  return {
    revision: 0,
    status: "OPEN",
    goalRevision: null,
    dialogue: {
      pendingClarification: null,
      pendingOps: [],
      focusOfferRef: null,
      comparisonOfferRefs: [],
      lastAssistantMessageId: null,
    },
    workingSet: null,
  };
}

describe("turn intent compiler", () => {
  it("uses message provenance, not user wording, to resolve superseding singleton effects", () => {
    const compiled = compileTurnIntent({
      userIntentSummary: "scope correction",
      ops: [
        { opId: "old", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US", "SG"] },
        { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["SG"] },
      ],
      leftover: [],
    }, emptyState());
    expect(compiled.ops).toEqual([
      { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["SG"] },
    ]);
  });

  it("is invariant to summaries and operation array order when source provenance is unchanged", () => {
    const proposals = [
      {
        userIntentSummary: "please narrow the scope",
        ops: [
          { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 1, markets: ["SG"] },
          { opId: "old", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 0, markets: ["US", "SG"] },
        ],
        leftover: [],
      },
      {
        userIntentSummary: "用户调整了检索范围",
        ops: [
          { opId: "old", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 0, markets: ["US", "SG"] },
          { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS" as const, sourceMessageOrdinal: 1, markets: ["SG"] },
        ],
        leftover: [],
      },
    ];
    for (const proposal of proposals) {
      expect(compileTurnIntent(proposal, emptyState()).ops).toEqual([
        { opId: "new", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 1, markets: ["SG"] },
      ]);
    }
  });

  it("keeps independent semantic effects from the same message", () => {
    const compiled = compileTurnIntent({
      userIntentSummary: "compound change",
      ops: [
        { opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "3000", currency: "CNY" } },
        { opId: "market", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US"] },
      ],
      leftover: [],
    }, emptyState());
    expect(compiled.ops.map((operation) => operation.kind)).toEqual(["GOAL_SET_BUDGET", "GOAL_SET_RETRIEVAL_MARKETS"]);
  });

  it("derives mechanical price reranking without parsing prose", () => {
    const state = emptyState();
    state.workingSet = {
      version: 1,
      boundGoalVersion: 1,
      pool: [],
      displayOfferRefs: [],
      mentionedOfferRefs: [],
      comparisonOfferRefs: [],
      rejectedOfferRefs: [],
      focusOfferRef: null,
    };
    const compiled = compileTurnIntent({
      userIntentSummary: "prefer lower price",
      ops: [{
        opId: "preference",
        kind: "GOAL_UPSERT_PREFERENCE",
        sourceMessageOrdinal: 0,
        preference: { key: "price", value: "LOWER", weight: 1 },
      }],
      leftover: [],
    }, state);
    expect(compiled.ops.map((operation) => operation.kind)).toEqual(["GOAL_UPSERT_PREFERENCE", "RERANK_WORKING_SET"]);
  });
});
