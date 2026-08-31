import { createGoalRevision, createWorkingSet, emptyDialogueState, type ConversationState } from "@interec/domain";
import { describe, expect, it } from "vitest";

import { directPlanForTypedInputs, latestCompletedUserAssistantExchange, searchNeedForState } from "../src/conversation-worker.js";
import type { ConversationMessageRecord } from "../src/conversation-repository-types.js";

function state(workingSet: ConversationState["workingSet"]): ConversationState {
  return { revision: 1, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet };
}

describe("conversation worker search need", () => {
  it("does not treat an empty durable working set as sufficient coverage", () => {
    expect(searchNeedForState(state(null))).toBe("INSUFFICIENT_COVERAGE");
    expect(searchNeedForState(state(createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [] })))).toBe("INSUFFICIENT_COVERAGE");
  });

  it("projects the last successful adjacent pair and drops whole degraded trajectories", () => {
    const message = (id: string, role: "USER" | "ASSISTANT", content: string, outcome?: string): ConversationMessageRecord => ({
      id,
      conversationId: "conversation",
      seq: Number(id.slice(1)),
      role,
      payload: role === "ASSISTANT" ? { content, envelope: { outcome } } : { content },
      consumedByTurnId: null,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    const timeline = [
      message("m1", "USER", "预算和市场"),
      message("m2", "ASSISTANT", "已完成首轮", "NO_MATCH"),
      message("m3", "USER", "重新检索"),
      message("m4", "ASSISTANT", "请重述", "DEGRADED"),
      message("m5", "USER", "重新检索当前候选"),
      message("m6", "ASSISTANT", "请重述", "DEGRADED"),
      message("m7", "USER", "本轮当前输入"),
    ];
    expect(latestCompletedUserAssistantExchange(timeline, new Set(["m7"]))).toEqual([
      { role: "USER", content: "预算和市场" },
      { role: "ASSISTANT", content: "已完成首轮" },
    ]);
  });

  it("continues an initially blocked search after an authoritative market answer", () => {
    const source = { messageId: "initial-request" };
    const current: ConversationState = {
      revision: 1,
      status: "OPEN",
      goalRevision: createGoalRevision(null, [{
        opId: "target",
        kind: "GOAL_SET_TARGET",
        source,
        target: { categoryId: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
      }], "initial-turn"),
      dialogue: {
        ...emptyDialogueState(),
        pendingClarification: {
          clarificationId: "market-question",
          clarification: { kind: "PURCHASE_MARKET" },
          askedByMessageId: "assistant-question",
        },
      },
      workingSet: null,
    };
    const optionPlan = directPlanForTypedInputs([{
      type: "ANSWER_CLARIFICATION",
      clarificationId: "market-question",
      answer: { type: "OPTION", optionId: "US_SG" },
    }], current);
    expect(optionPlan.ops).toMatchObject([
      { kind: "GOAL_SET_RETRIEVAL_MARKETS", markets: ["US", "SG"] },
      { kind: "SEARCH_OFFERS", reasonCode: "GOAL_BECAME_SEARCH_READY" },
    ]);
    const skipPlan = directPlanForTypedInputs([{
      type: "ANSWER_CLARIFICATION",
      clarificationId: "market-question",
      answer: { type: "SKIP" },
    }], current);
    expect(skipPlan.ops).toMatchObject([{
      kind: "SEARCH_OFFERS",
      marketScope: ["US", "SG"],
      assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
    }]);
  });
});
