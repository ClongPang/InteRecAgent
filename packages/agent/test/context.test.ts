import { describe, expect, it } from "vitest";

import { createGoalRevision, createWorkingSet, emptyDialogueState, type ConversationState } from "@interec/domain";

import { projectConversationContext } from "../src/index.js";

const secretMessageId = "internal-message-id-must-not-leak";

function state(): ConversationState {
  const source = { messageId: secretMessageId };
  const goalRevision = createGoalRevision(null, [
    {
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
    },
    { opId: "constraint", kind: "GOAL_UPSERT_CONSTRAINT", source, constraint: { key: "color", operator: "EQ", value: "black" } },
  ], "internal-turn-id");
  const workingSet = createWorkingSet({
    version: 1,
    boundGoalVersion: 1,
    pool: Array.from({ length: 24 }, (_, index) => ({
      offerRef: `offer-${index + 1}`,
      title: `Sony WH-1000XM5 offer ${index + 1}`,
      canonicalModel: "WH-1000XM5",
      categoryId: "headphones",
      itemRole: "PRIMARY_PRODUCT" as const,
      condition: "NEW" as const,
      retrievalMarket: index % 2 === 0 ? "US" : "SG",
      merchant: `Merchant ${index + 1}`,
      cnyAmount: String(2_000 + index),
      stock: "UNKNOWN" as const,
      claimIds: [`claim-${index + 1}`],
    })),
  });
  return {
    revision: 3,
    status: "OPEN",
    goalRevision,
    dialogue: {
      ...emptyDialogueState(),
      pendingClarification: { clarificationId: "clarification-budget", clarification: { kind: "BUDGET" }, askedByMessageId: secretMessageId },
      pendingOps: [{ operation: { opId: "pending", kind: "GOAL_CLEAR_BUDGET", source }, conditionCode: "AFTER_CLARIFICATION" }],
      lastAssistantMessageId: "internal-assistant-id",
    },
    workingSet,
  };
}

function baseInput() {
  return {
    state: state(),
    currentUserMessages: ["预算改成 2500，然后比较前两个"],
    capabilities: ["sort", "compare"],
    now: "2026-08-26T00:00:00.000Z",
    modelId: "faux-model",
    providerCallBudget: 0,
  };
}

describe("bounded conversation context", () => {
  it("includes an uncropped full transcript only when the evaluation caller explicitly supplies it", () => {
    const input = baseInput();
    const projection = projectConversationContext({
      ...input,
      fullTranscript: [
        { role: "USER", content: "  最早提出的预算是 3000 元。  " },
        { role: "ASSISTANT", content: "已记录。" },
      ],
      maxInputTokens: 16_000,
    });

    expect(projection.fullTranscript).toEqual([
      { role: "USER", content: "最早提出的预算是 3000 元。" },
      { role: "ASSISTANT", content: "已记录。" },
    ]);
    expect(projectConversationContext(input)).not.toHaveProperty("fullTranscript");
  });

  it("projects only the controlled turn context and strips database IDs", () => {
    const projection = projectConversationContext({
      state: state(),
      currentUserMessages: ["预算改成 2500，然后比较前两个"],
      uiFocusOfferRef: "offer-2",
      recentAdjacentPair: [{ role: "USER", content: "之前的上下文" }, { role: "ASSISTANT", content: "之前的回复" }],
      capabilities: ["sort", "compare", "sort"],
      now: "2026-08-26T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 0,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(secretMessageId);
    expect(serialized).not.toContain("internal-turn-id");
    expect(serialized).not.toContain("internal-assistant-id");
    expect(projection.currentUserMessages).toEqual([{ ordinal: 0, content: "预算改成 2500,然后比较前两个", truncated: false }]);
    expect(projection.dialogue.pendingClarification).toEqual({ clarificationId: "clarification-budget", clarification: { kind: "BUDGET" } });
    expect(projection.uiContext).toEqual({ focusOfferRef: "offer-2" });
    expect(projection.workingSet?.candidates).toHaveLength(20);
    expect(projection.runtime).toMatchObject({ capabilities: ["compare", "sort"], providerCallBudget: 0 });
    expect(projection.runtime.estimatedInputTokens).toBeLessThanOrEqual(8_000);
  });

  it("preserves every batch ordinal while bounding individual message content", () => {
    const projection = projectConversationContext({
      state: { revision: 0, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet: null },
      currentUserMessages: ["a".repeat(3_000), "第二条纠正"],
      capabilities: [],
      now: "2026-08-26T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 0,
    });
    expect(projection.currentUserMessages.map((message) => message.ordinal)).toEqual([0, 1]);
    expect(projection.currentUserMessages[0]).toMatchObject({ truncated: true });
    expect(projection.currentUserMessages[1]).toMatchObject({ content: "第二条纠正", truncated: false });
  });

  it("does not project the generic protocol-recovery clarification as a product gap", () => {
    const current = state();
    current.dialogue.pendingClarification = { clarification: { kind: "TURN_REPHRASE" }, askedByMessageId: secretMessageId };
    const projection = projectConversationContext({
      state: current,
      currentUserMessages: ["预算 2500 元，比较美国和新加坡"],
      capabilities: ["search"],
      now: "2026-08-26T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 1,
    });
    expect(projection.dialogue.pendingClarification).toBeNull();
  });

  it("fails closed when the controlled snapshot still exceeds its budget", () => {
    expect(() => projectConversationContext({
      state: state(),
      currentUserMessages: ["预算"],
      capabilities: [],
      now: "2026-08-26T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 0,
      maxInputTokens: 30,
    })).toThrowError(/CONVERSATION_CONTEXT_BUDGET_EXCEEDED/);
  });
});
