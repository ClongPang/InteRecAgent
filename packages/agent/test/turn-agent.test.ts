import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { emptyDialogueState, validateTurnPlan, type TurnOperation, type TurnPlan } from "@interec/domain";
import { describe, expect, it } from "vitest";

import {
  executeConversationTurn,
  type ConversationTurnAgentOptions,
  type AssistantEnvelopeProposal,
  type OperationReceipt,
  type ProposedTurnOperation,
  type TurnHostOperations,
  type TurnPlanProposal,
} from "../src/index.js";

function context() {
  return {
    state: { revision: 0, status: "OPEN" as const, goalRevision: null, dialogue: emptyDialogueState(), workingSet: null },
    currentUserMessages: ["预算改成 2500，先不要重新搜索"],
    capabilities: ["patch_goal", "talk"],
    now: "2026-08-26T00:00:00.000Z",
    modelId: "faux-model",
    providerCallBudget: 0,
  };
}

function bindProposal(proposal: TurnPlanProposal): TurnPlan {
  const bind = (operation: ProposedTurnOperation): TurnOperation => {
    if ("sourceMessageOrdinal" in operation) {
      const { sourceMessageOrdinal, sourceSpan, ...rest } = operation;
      if (sourceMessageOrdinal !== 0) throw new Error("SOURCE_ORDINAL_NOT_FOUND");
      return {
        ...rest,
        source: { messageId: "real-message-id", ...(sourceSpan ? { span: sourceSpan } : {}) },
      } as TurnOperation;
    }
    return operation as TurnOperation;
  };
  return validateTurnPlan({
    userIntentSummary: proposal.userIntentSummary,
    ops: proposal.ops.map(bind),
    leftover: proposal.leftover.map((pending) => ({ conditionCode: pending.conditionCode, operation: bind(pending.operation) })),
  });
}

function host(overrides: Partial<TurnHostOperations> = {}) {
  const executed: string[] = [];
  const published: AssistantEnvelopeProposal[] = [];
  const fallbacks: string[] = [];
  let currentPlan: TurnPlan | null = null;
  const operations: TurnHostOperations = {
    commitPlan: async (proposal) => {
      currentPlan = bindProposal(proposal);
      return { plan: currentPlan, route: "talk", maxModelInferences: 2 };
    },
    executeOperation: async (operation) => {
      executed.push(operation.opId);
      const toolName: Record<string, string> = {
        GOAL_SET_BUDGET: "patch_goal",
        GOAL_UPSERT_PREFERENCE: "patch_goal",
        REJECT_OFFERS: "reject_offers",
        RERANK_WORKING_SET: "rerank_working_set",
        INSPECT_WORKING_SET: "inspect_working_set",
        INSPECT_RESEARCH_COVERAGE: "inspect_research_coverage",
        REQUEST_CLARIFICATION: "request_clarification",
        RESEARCH_OFFERS: "research_offers",
      };
      return { opId: operation.opId, toolName: toolName[operation.kind]!, status: "APPLIED", claimIds: [], questionSlotIds: [], disclosureCodes: [], publicResult: {} };
    },
    publishReply: async (envelope) => {
      published.push(envelope);
      return { ...envelope, addressedOpIds: currentPlan?.ops.map((operation) => operation.opId) ?? [] };
    },
    fallbackReply: async (code, plan) => {
      fallbacks.push(code);
      return {
        outcome: "DEGRADED",
        addressedOpIds: plan?.ops.map((operation) => operation.opId) ?? ["unplanned"],
        blocks: [{ type: "TRANSITION", text: "这轮没有安全完成，请继续补充或重试。" }],
        nextMoves: [],
      };
    },
    ...overrides,
  };
  return { operations, executed, published, fallbacks };
}

async function runFaux(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  operations: TurnHostOperations,
  instrumentation: Pick<ConversationTurnAgentOptions, "onEvent" | "onModelCall" | "observeToolCall"> = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const result = await executeConversationTurn({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    host: operations,
    context: context(),
    sessionId: `attempt-${Math.random()}`,
    ...instrumentation,
  });
  return { result, faux };
}

describe("fresh pi-agent conversational turn", () => {
  it("exposes provider-boundary context and preserves tool-call causality across generations", async () => {
    const harness = host();
    const modelCalls: Array<{ phase: string; inferenceIndex: number; context: unknown }> = [];
    const toolCalls: Array<{ toolCallId: string; toolName: string; phase: string; inferenceIndex: number }> = [];
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "set the budget without research",
        ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
      }, { id: "call-plan" })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT",
        blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }],
        nextMoves: [],
      }, { id: "call-finalize" })),
    ], harness.operations, {
      onModelCall: (call) => modelCalls.push({
        phase: call.phase,
        inferenceIndex: call.inferenceIndex,
        context: JSON.parse(JSON.stringify(call.context)) as unknown,
      }),
      observeToolCall: async (call, operation) => {
        toolCalls.push({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          phase: call.phase,
          inferenceIndex: call.inferenceIndex,
        });
        return operation();
      },
    });
    expect(result.usedFallback).toBe(false);
    expect(modelCalls.map(({ phase, inferenceIndex }) => ({ phase, inferenceIndex }))).toEqual([
      { phase: "PLAN", inferenceIndex: 1 },
      { phase: "FINALIZE", inferenceIndex: 2 },
    ]);
    expect(toolCalls).toEqual([
      { toolCallId: "call-plan", toolName: "commit_turn_plan", phase: "PLAN", inferenceIndex: 1 },
      { toolCallId: "call-finalize", toolName: "publish_reply", phase: "FINALIZE", inferenceIndex: 2 },
    ]);
    const secondContext = modelCalls[1]!.context as { messages: Array<Record<string, unknown>> };
    expect(secondContext.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: expect.arrayContaining([
        expect.objectContaining({ type: "toolCall", id: "call-plan", name: "commit_turn_plan" }),
      ]) }),
      expect.objectContaining({ role: "toolResult", toolCallId: "call-plan", toolName: "commit_turn_plan", isError: false }),
    ]));
  });

  it("accepts the dedicated zero-provider operation for historical research coverage", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "check whether the prior market search failed",
        ops: [{ opId: "coverage", kind: "INSPECT_RESEARCH_COVERAGE" }],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT",
        blocks: [{ type: "TRANSITION", transitionCode: "CHECKED_PREMISE" }],
        nextMoves: [],
      })),
    ], harness.operations);
    expect(result.usedFallback).toBe(false);
    expect(result.receipts).toMatchObject([{ toolName: "inspect_research_coverage" }]);
    expect(result.route).toBe("talk");
  });

  it("binds public message ordinals, executes the ordered plan in the host, and publishes in two inferences", async () => {
    const harness = host();
    const { result, faux } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "set the budget without research",
        ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT",
        blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }],
        nextMoves: [],
      })),
    ], harness.operations);
    expect(result).toMatchObject({ route: "talk", modelInferences: 2, toolCalls: 2, usedFallback: false });
    expect(result.plan?.ops[0]).toMatchObject({ opId: "budget", source: { messageId: "real-message-id" } });
    expect(harness.executed).toEqual(["budget"]);
    expect(harness.published).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
  });

  it("normalizes transition-attached claim IDs into standard claim blocks", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "set the budget",
        ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT",
        blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED", claimIds: ["claim:verified"] }],
        nextMoves: [],
      })),
    ], harness.operations);
    expect(result.usedFallback).toBe(false);
    expect(harness.published[0]?.blocks).toEqual([
      { type: "TRANSITION", transitionCode: "STATE_UPDATED" },
      { type: "CLAIM", claimId: "claim:verified" },
    ]);
  });

  it("preserves compound operation order without phrase-specific branches", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "reject second, prefer cheaper, inspect third",
        ops: [
          { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
          { opId: "preference", kind: "GOAL_UPSERT_PREFERENCE", sourceMessageOrdinal: 0, preference: { key: "price", value: "LOWER", weight: 1 } },
          { opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "DISPLAY_RANK", rank: 3 }], fields: ["PRICE"] },
        ],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT",
        blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }],
        nextMoves: [],
      })),
    ], harness.operations);
    expect(harness.executed).toEqual(["reject", "preference", "inspect"]);
    expect(result.receipts.map((receipt: OperationReceipt) => receipt.toolName)).toEqual(["reject_offers", "patch_goal", "inspect_working_set"]);
  });

  it("uses deterministic fallback when the model does not follow the tool protocol", async () => {
    const harness = host();
    const { result, faux } = await runFaux([
      fauxAssistantMessage("我直接回答，不调用工具。"),
      fauxAssistantMessage("仍然直接回答。"),
    ], harness.operations);
    expect(result).toMatchObject({ usedFallback: true, modelInferences: 2 });
    expect(result.envelope.outcome).toBe("DEGRADED");
    expect(harness.executed).toEqual([]);
    expect(harness.fallbacks).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
  });

  it("repairs one pre-plan protocol miss inside the same fresh agent session", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage("I forgot to call the required tool."),
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "set the budget after protocol repair",
        ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT",
        blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }],
        nextMoves: [],
      })),
    ], harness.operations);
    expect(result).toMatchObject({ usedFallback: false, modelInferences: 3, toolCalls: 2 });
    expect(harness.executed).toEqual(["budget"]);
  });

  it("publishes after a rejected first plan and a successful repaired plan", async () => {
    let commits = 0;
    const harness = host({
      commitPlan: async (proposal) => {
        commits += 1;
        if (commits === 1) throw new Error("RESEARCH_MARKETS_REQUIRED");
        return { plan: bindProposal(proposal), route: "clarify", maxModelInferences: 2 };
      },
    });
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "invalid research without market",
        ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "ask for the missing market",
        ops: [{ opId: "ask-market", kind: "REQUEST_CLARIFICATION", slotId: "retrieval_market", reasonCode: "MISSING_MARKET" }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CLARIFICATION", blocks: [{ type: "QUESTION", slotId: "retrieval_market" }], nextMoves: [],
      })),
    ], harness.operations);
    expect(result).toMatchObject({ usedFallback: false, modelInferences: 3, toolCalls: 3, route: "clarify" });
    expect(harness.published).toHaveLength(1);
  });

  it("allows one answer self-correction within the research inference budget", async () => {
    let publishAttempts = 0;
    const harness = host({
      commitPlan: async (proposal) => ({ plan: bindProposal(proposal), route: "research", maxModelInferences: 4 }),
      publishReply: async (candidate) => {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("CLAIM_NOT_FOUND");
        return candidate;
      },
    });
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "research because coverage is insufficient",
        ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE", queryVariant: "WH-1000XM5" }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT", blocks: [{ type: "CLAIM", claimId: "invented" }], nextMoves: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "DEGRADED", blocks: [{ type: "TRANSITION", transitionCode: "EVIDENCE_SUMMARY" }], nextMoves: [],
      })),
    ], harness.operations);
    expect(result).toMatchObject({ route: "research", usedFallback: false, modelInferences: 3, toolCalls: 3 });
    expect(publishAttempts).toBe(2);
  });

  it("opens a bounded repair window when a dialogue reply cites stale claims", async () => {
    let publishAttempts = 0;
    const harness = host({
      publishReply: async (candidate) => {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("CLAIM_NOT_FOUND");
        return candidate;
      },
    });
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "rerank existing candidates",
        ops: [{ opId: "preference", kind: "GOAL_UPSERT_PREFERENCE", sourceMessageOrdinal: 0, preference: { key: "price", value: "LOWER", weight: 1 } }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT", blocks: [{ type: "CLAIM", claimId: "stale" }], nextMoves: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CHAT", blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }], nextMoves: [],
      })),
    ], harness.operations);
    expect(result).toMatchObject({ route: "talk", usedFallback: false, modelInferences: 3, toolCalls: 3 });
    expect(publishAttempts).toBe(2);
  });

  it("falls back when host policy rejects an unnecessary research plan", async () => {
    const harness = host({ commitPlan: async () => { throw new Error("UNNECESSARY_PROVIDER_RESEARCH"); } });
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "search despite sufficient evidence",
        ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "NOT_NEEDED" }],
        leftover: [],
      })),
      fauxAssistantMessage("无法继续。"),
    ], harness.operations);
    expect(result.usedFallback).toBe(true);
    expect(harness.executed).toEqual([]);
  });

  it("does not submit a second plan after an operation fails in a committed plan", async () => {
    const harness = host({ executeOperation: async () => { throw new Error("RESEARCH_MARKETS_REQUIRED"); } });
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "invalid research execution",
        ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "must never be submitted",
        ops: [{ opId: "research-2", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
        leftover: [],
      })),
    ], harness.operations);
    expect(result).toMatchObject({ usedFallback: true, fallbackReasonCode: "RESEARCH_MARKETS_REQUIRED", modelInferences: 1 });
    expect(harness.fallbacks).toEqual(["RESEARCH_MARKETS_REQUIRED"]);
  });

  it("fails closed on an operation source ordinal outside the current message batch", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "use a nonexistent source message",
        ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 7, budget: { amount: "2500", currency: "CNY" } }],
        leftover: [],
      })),
      fauxAssistantMessage("cannot recover within the normal budget"),
    ], harness.operations);
    expect(result.usedFallback).toBe(true);
    expect(result.plan).toBeNull();
    expect(harness.executed).toEqual([]);
  });

  it("blocks tools that are not exposed in the current protocol phase", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("discover_offers", { queryVariant: "forbidden legacy tool" })),
    ], harness.operations);
    expect(result.usedFallback).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(harness.executed).toEqual([]);
  });

  it("stops at the hard inference/tool budget and uses deterministic fallback", async () => {
    let publishAttempts = 0;
    const harness = host({
      commitPlan: async (proposal) => ({ plan: bindProposal(proposal), route: "research", maxModelInferences: 4 }),
      publishReply: async () => {
        publishAttempts += 1;
        throw new Error("ENVELOPE_STILL_INVALID");
      },
    });
    const invalidReply = fauxAssistantMessage(fauxToolCall("publish_reply", {
      outcome: "DEGRADED", blocks: [{ type: "TRANSITION", transitionCode: "EVIDENCE_SUMMARY" }], nextMoves: [],
    }));
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "research within a bounded attempt",
        ops: [{ opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
        leftover: [],
      })),
      invalidReply,
      invalidReply,
      invalidReply,
    ], harness.operations);
    expect(result).toMatchObject({ usedFallback: true, modelInferences: 4 });
    expect(result.toolCalls).toBe(4);
    expect(publishAttempts).toBe(3);
  });
});
