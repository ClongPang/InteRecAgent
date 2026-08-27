import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { emptyDialogueState, validateTurnPlan, type TurnOperation, type TurnPlan } from "@interec/domain";
import { describe, expect, it } from "vitest";

import {
  executeConversationTurn,
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
        REJECT_OFFERS: "reject_offers",
        RERANK_WORKING_SET: "rerank_working_set",
        INSPECT_WORKING_SET: "inspect_working_set",
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

async function runFaux(responses: ReturnType<typeof fauxAssistantMessage>[], operations: TurnHostOperations) {
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
  });
  return { result, faux };
}

describe("fresh pi-agent conversational turn", () => {
  it("binds public message ordinals, executes the ordered plan in the host, and publishes in two inferences", async () => {
    const harness = host();
    const { result, faux } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "set the budget without research",
        ops: [{ opId: "budget", kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: 0, budget: { amount: "2500", currency: "CNY" } }],
        leftover: [],
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

  it("preserves compound operation order without phrase-specific branches", async () => {
    const harness = host();
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "reject second, prefer cheaper, inspect third",
        ops: [
          { opId: "reject", kind: "REJECT_OFFERS", referents: [{ kind: "DISPLAY_RANK", rank: 2 }], reasonCode: "USER_REJECTED" },
          { opId: "rerank", kind: "RERANK_WORKING_SET", preferenceKey: "price:lower" },
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
    expect(harness.executed).toEqual(["reject", "rerank", "inspect"]);
    expect(result.receipts.map((receipt: OperationReceipt) => receipt.toolName)).toEqual(["reject_offers", "rerank_working_set", "inspect_working_set"]);
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
    expect(publishAttempts).toBe(2);
  });
});
