import { createWorkingSet, emptyDialogueState, type ConversationState } from "@interec/domain";
import { describe, expect, it } from "vitest";

import { recentSuccessfulAdjacentPair, researchNeedForState } from "../src/conversation-worker.js";
import type { ConversationMessageRecord } from "../src/conversation-repository-types.js";

function state(workingSet: ConversationState["workingSet"]): ConversationState {
  return { revision: 1, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet };
}

describe("conversation worker research need", () => {
  it("does not treat an empty durable working set as sufficient coverage", () => {
    expect(researchNeedForState(state(null))).toBe("INSUFFICIENT_COVERAGE");
    expect(researchNeedForState(state(createWorkingSet({ version: 1, boundGoalVersion: 1, pool: [] })))).toBe("INSUFFICIENT_COVERAGE");
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
    expect(recentSuccessfulAdjacentPair(timeline, new Set(["m7"]))).toEqual([
      { role: "USER", content: "预算和市场" },
      { role: "ASSISTANT", content: "已完成首轮" },
    ]);
  });
});
