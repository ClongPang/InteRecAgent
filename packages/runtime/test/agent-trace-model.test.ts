import { describe, expect, it } from "vitest";

import {
  AgentCausalityLedger,
  buildAgentModelBoundaryManifest,
  traceValueSha256,
} from "../src/agent-trace-model.js";

function modelCall(input: {
  inferenceIndex: number;
  messages: Array<Record<string, unknown>>;
  parameters?: Record<string, unknown>;
  timestamp?: number;
}) {
  return {
    model: { id: "model-a", provider: "provider-a", api: "openai-completions" },
    context: {
      systemPrompt: "system",
      messages: input.messages,
      tools: [{
        name: "commit_quote_plan",
        description: "Commit the plan",
        parameters: input.parameters ?? { type: "object", properties: { route: { type: "string" } } },
      }],
    },
    options: { temperature: 0 },
    inferenceIndex: input.inferenceIndex,
    phase: input.inferenceIndex === 1 ? "PLAN" : "REPAIR_PLAN",
  } as never;
}

function assistantToolCall(id: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "commit_quote_plan", arguments: { route: "quote_lookup" } }],
  } as never;
}

function observedCall(id: string, inferenceIndex: number) {
  return {
    toolCallId: id,
    toolName: "commit_quote_plan",
    arguments: { route: "quote_lookup" },
    inferenceIndex,
    phase: inferenceIndex === 1 ? "PLAN" : "REPAIR_PLAN",
  } as never;
}

describe("agent model boundary manifest", () => {
  it("is stable across local timestamps and object key order", () => {
    const first = buildAgentModelBoundaryManifest(modelCall({
      inferenceIndex: 1,
      messages: [{ role: "user", content: "Sony WH-1000XM5", timestamp: 1 }],
      parameters: {
        type: "object",
        properties: { route: { type: "string" }, target: { type: "string" } },
      },
    }));
    const second = buildAgentModelBoundaryManifest(modelCall({
      inferenceIndex: 1,
      messages: [{ role: "user", content: "Sony WH-1000XM5", timestamp: 999_999 }],
      parameters: {
        properties: { target: { type: "string" }, route: { type: "string" } },
        type: "object",
      },
    }));
    expect(second).toEqual(first);
  });

  it("changes when model-visible content changes", () => {
    const first = buildAgentModelBoundaryManifest(modelCall({
      inferenceIndex: 1,
      messages: [{ role: "user", content: "Sony WH-1000XM5", timestamp: 1 }],
    }));
    const second = buildAgentModelBoundaryManifest(modelCall({
      inferenceIndex: 1,
      messages: [{ role: "user", content: "Sony WH-1000XM4", timestamp: 1 }],
    }));
    expect(second.contextSha256).not.toBe(first.contextSha256);
    expect(second.toolSchemaSha256).toBe(first.toolSchemaSha256);
  });

  it("uses a keyed digest when telemetry leaves the process", () => {
    const value = { message: "low entropy private query" };
    expect(traceValueSha256(value)).toMatch(/^sha256:/);
    const keyed = traceValueSha256(value, "telemetry-pseudonym-key-with-at-least-32-bytes");
    expect(keyed).toMatch(/^hmac-sha256:/);
    expect(keyed).not.toContain("low entropy private query");
    expect(keyed).not.toBe(traceValueSha256(value, "another-telemetry-key-with-at-least-32-bytes"));
  });
});

describe("agent causality ledger", () => {
  it("proves a non-terminal tool result was consumed by a later inference", () => {
    const ledger = new AgentCausalityLedger();
    const firstResult = { content: [{ type: "text", text: "REPAIR_REQUIRED" }] };
    ledger.recordModelInput(modelCall({
      inferenceIndex: 1,
      messages: [{ role: "user", content: "quote", timestamp: 1 }],
    }));
    ledger.recordModelOutput(assistantToolCall("call-1"), 1);
    ledger.recordToolStart("call-1", "commit_quote_plan");
    ledger.recordToolObservation(observedCall("call-1", 1), firstResult);
    ledger.recordToolEnd({ toolCallId: "call-1", toolName: "commit_quote_plan", result: firstResult, isError: false });

    ledger.recordModelInput(modelCall({
      inferenceIndex: 2,
      messages: [
        { role: "user", content: "quote", timestamp: 1 },
        assistantToolCall("call-1"),
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "commit_quote_plan",
          content: firstResult.content,
          details: { internal: "not-provider-visible" },
          isError: false,
          timestamp: 2,
        },
      ],
    }));
    ledger.recordModelOutput(assistantToolCall("call-2"), 2);
    ledger.recordToolStart("call-2", "commit_quote_plan");
    const finalResult = { content: [{ type: "text", text: "accepted" }], terminate: true };
    ledger.recordToolObservation(observedCall("call-2", 2), finalResult);
    ledger.recordToolEnd({ toolCallId: "call-2", toolName: "commit_quote_plan", result: finalResult, isError: false });

    expect(ledger.report()).toMatchObject({
      passed: true,
      requestedToolCalls: 2,
      consumedToolResults: 1,
      unconsumedToolResultIds: [],
      resultMismatchToolCallIds: [],
    });
  });

  it("fails when a non-terminal result never reaches a later model context", () => {
    const ledger = new AgentCausalityLedger();
    const result = { content: [{ type: "text", text: "REPAIR_REQUIRED" }] };
    ledger.recordModelOutput(assistantToolCall("call-lost"), 1);
    ledger.recordToolStart("call-lost", "commit_quote_plan");
    ledger.recordToolObservation(observedCall("call-lost", 1), result);
    ledger.recordToolEnd({ toolCallId: "call-lost", toolName: "commit_quote_plan", result, isError: false });
    expect(ledger.report()).toMatchObject({
      passed: false,
      unconsumedToolResultIds: ["call-lost"],
    });
  });

  it("fails on result substitution even when lifecycle events all exist", () => {
    const ledger = new AgentCausalityLedger();
    const hostResult = { content: [{ type: "text", text: "host-result" }] };
    ledger.recordModelOutput(assistantToolCall("call-mutated"), 1);
    ledger.recordToolStart("call-mutated", "commit_quote_plan");
    ledger.recordToolObservation(observedCall("call-mutated", 1), hostResult);
    ledger.recordToolEnd({
      toolCallId: "call-mutated",
      toolName: "commit_quote_plan",
      result: { content: [{ type: "text", text: "different-result" }], terminate: true },
      isError: false,
    });
    expect(ledger.report()).toMatchObject({
      passed: false,
      resultMismatchToolCallIds: ["call-mutated"],
    });
  });
});
