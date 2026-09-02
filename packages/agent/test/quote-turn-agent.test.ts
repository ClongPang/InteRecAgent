import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  emptyQuoteConversationState,
  resolveQuoteTarget,
  type PublishedQuoteLeadSet,
} from "@retail-price/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createLexicallyGroundedIdentityHypothesis,
  executeQuoteConversationTurn,
  QuoteConversationTurnExecutor,
  type QuoteConversationTurnAgentOptions,
} from "../src/index.js";

const EXACT_USER = "Sony WH-1000XM5 headphones";

function target() {
  const resolved = resolveQuoteTarget({
    rawText: "Sony WH-1000XM5 headphones",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  if (resolved.status !== "RESOLVED") throw new Error("target fixture failed");
  return resolved.target;
}

function leadSet(): PublishedQuoteLeadSet {
  const quoteTarget = target();
  return {
    contractVersion: "quote-leads-sg-v1",
    quoteLeadSetRef: "qls_agent",
    targetRef: quoteTarget.targetRef,
    outcome: "QUOTE_LEADS",
    reasonCodes: [],
    providerStatus: "OK_RESULTS",
    providerFailureCode: null,
    providerRetryable: null,
    providerContractVersion: "buywhere-test",
    leads: [{
      quoteLeadRef: "ql_1",
      canonicalModel: quoteTarget.canonicalModel,
      representativeTitle: "Sony WH-1000XM5 Headphones",
      condition: "NEW",
      merchantLabel: "Example merchant",
      merchantDomain: "merchant.example",
      outboundUrl: "https://merchant.example/product",
      priceRanges: [{
        originalPrice: { currency: "SGD", minAmount: "399.00", maxAmount: "399.00" },
        cnyEstimate: null,
      }],
      observationCount: 1,
      firstObservedAt: "2026-09-01T00:00:00.000Z",
      latestObservedAt: "2026-09-01T00:00:00.000Z",
    }],
    observedAt: "2026-09-01T00:00:00.000Z",
  };
}

function executor(lookup = vi.fn(async () => leadSet())) {
  return new QuoteConversationTurnExecutor({
    turnId: "turn-agent",
    inputMessageIds: ["m1"],
    inputMessageContents: [EXACT_USER],
    baseState: emptyQuoteConversationState(),
    publicationRevision: 1,
    quoteEffects: { execute: async (effect) => ({ status: "SUCCEEDED", leadSet: await lookup(effect.target), providerInvocation: "LIVE" }) },
  });
}

function context() {
  return {
    state: emptyQuoteConversationState(),
    currentUserMessages: [EXACT_USER],
    now: "2026-09-01T00:00:00.000Z",
    modelId: "faux-model",
    providerCallBudget: 1 as const,
  };
}

async function runFaux(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  turnExecutor: QuoteConversationTurnExecutor,
  instrumentation: Pick<QuoteConversationTurnAgentOptions, "onEvent" | "onModelCall" | "observeToolCall"> = {},
  extra: Partial<Pick<QuoteConversationTurnAgentOptions, "signal" | "apiKey">> = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const result = await executeQuoteConversationTurn({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    executor: turnExecutor,
    context: context(),
    sessionId: `quote-attempt-${Math.random()}`,
    ...instrumentation,
    ...extra,
  });
  return { result, faux };
}

function validPlan() {
  const target = {
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
    requiredQualifiers: [],
    conditionPreference: "ANY" as const,
  };
  return {
    userIntentSummary: "look up the exact model",
    ops: [
      {
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        sourceMessageOrdinal: 0,
        identityHypothesis: createLexicallyGroundedIdentityHypothesis(EXACT_USER, 0, target),
        target,
      },
      { opId: "lookup", kind: "LOOKUP_QUOTES" },
    ],
  };
}

describe("quote-only pi-agent turn", () => {
  it("commits one reviewed plan, publishes host-rendered quote facts, and records causality", async () => {
    const modelCalls: Array<{ phase: string; inferenceIndex: number; temperature: number | undefined; toolChoice: unknown }> = [];
    const toolCalls: Array<{ id: string; phase: string; inferenceIndex: number }> = [];
    const events: string[] = [];
    const { result, faux } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_quote_plan", validPlan(), { id: "call-plan" })),
    ], executor(), {
      onEvent: (event) => events.push(event.type),
      onModelCall: (call) => modelCalls.push({
        phase: call.phase,
        inferenceIndex: call.inferenceIndex,
        temperature: call.options?.temperature,
        toolChoice: call.options?.toolChoice,
      }),
      observeToolCall: async (call, operation) => {
        toolCalls.push({ id: call.toolCallId, phase: call.phase, inferenceIndex: call.inferenceIndex });
        return operation();
      },
    }, { apiKey: "test-key" });

    expect(result).toMatchObject({
      route: "quote_lookup",
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
    });
    expect(result.reply.outcome).toBe("QUOTE_LEADS");
    expect(result.plan?.ops.map((operation) => operation.kind)).toEqual(["SET_QUOTE_TARGET", "LOOKUP_QUOTES"]);
    expect(result.receipts).toHaveLength(2);
    expect(result.context.runtime.serviceMarket).toBe("SG");
    expect(result.modelUsage.responses).toBe(1);
    expect(modelCalls).toEqual([{ phase: "PLAN", inferenceIndex: 1, temperature: 0, toolChoice: "required" }]);
    expect(toolCalls).toEqual([{ id: "call-plan", phase: "PLAN", inferenceIndex: 1 }]);
    expect(events).toContain("tool_execution_end");
    expect(faux.state.callCount).toBe(1);
  });

  it("opens exactly one structured repair window for a rejected plan", async () => {
    const calls: Array<{ phase: string; inferenceIndex: number }> = [];
    const { result, faux } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_quote_plan", {
        userIntentSummary: "look up without establishing a target",
        ops: [{ opId: "lookup", kind: "LOOKUP_QUOTES" }],
      }, { id: "bad-plan" })),
      fauxAssistantMessage(fauxToolCall("commit_quote_plan", validPlan(), { id: "repaired-plan" })),
    ], executor(), {
      observeToolCall: async (call, operation) => {
        calls.push({ phase: call.phase, inferenceIndex: call.inferenceIndex });
        return operation();
      },
    });

    expect(result).toMatchObject({ usedFallback: false, modelInferences: 2, toolCalls: 2, route: "quote_lookup" });
    expect(calls).toEqual([
      { phase: "PLAN", inferenceIndex: 1 },
      { phase: "REPAIR_PLAN", inferenceIndex: 2 },
    ]);
    expect(faux.state.callCount).toBe(2);
  });

  it("falls back deterministically when the model never uses the required tool", async () => {
    const { result, faux } = await runFaux([
      fauxAssistantMessage("I will answer directly."),
      fauxAssistantMessage("I still will not call the tool."),
    ], executor());

    expect(result).toMatchObject({
      usedFallback: true,
      modelInferences: 1,
      toolCalls: 0,
      plan: null,
      route: null,
      receipts: [],
      fallbackReasonCode: "QUOTE_AGENT_INCOMPLETE",
    });
    expect(result.reply.outcome).toBe("DEGRADED");
    expect(faux.state.callCount).toBe(1);
  });

  it("fails closed and preserves the existing state when approved execution raises", async () => {
    const failingLookup = vi.fn(async () => {
      throw new Error("BUYWHERE_TIMEOUT");
    });
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_quote_plan", validPlan(), { id: "failing-plan" })),
    ], executor(failingLookup));

    expect(failingLookup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      usedFallback: true,
      modelInferences: 1,
      toolCalls: 1,
      plan: null,
      route: null,
      fallbackReasonCode: "BUYWHERE_TIMEOUT",
    });
    expect(result.reply.outcome).toBe("DEGRADED");
  });

  it("honors a pre-aborted turn and never executes the proposed plan", async () => {
    const lookup = vi.fn(async () => leadSet());
    const controller = new AbortController();
    controller.abort(new Error("USER_CANCELLED"));
    const { result } = await runFaux([
      fauxAssistantMessage(fauxToolCall("commit_quote_plan", validPlan(), { id: "aborted-plan" })),
    ], executor(lookup), {}, { signal: controller.signal });

    expect(lookup).not.toHaveBeenCalled();
    expect(result.usedFallback).toBe(true);
    expect(result.toolCalls).toBe(1);
    expect(result.reply.outcome).toBe("DEGRADED");
  });
});
