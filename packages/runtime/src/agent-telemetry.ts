import { createHash } from "node:crypto";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  startActiveObservation,
  startObservation,
  type LangfuseGeneration,
} from "@langfuse/tracing";
import type {
  AgentModelCallObservation,
  ObserveAgentToolCall,
} from "@interec/agent";

import {
  recordGuardrailDecision,
  telemetryContent,
  telemetryErrorCode,
} from "./telemetry-safety.js";

interface AgentEventObserverOptions {
  promptName: string;
  promptVersion: string;
  promptSha256: string;
  promptLink?: {
    name: string;
    version: number;
    isFallback: boolean;
  };
}

export interface AgentEventObserver {
  onModelCall(call: AgentModelCallObservation): void;
  onEvent(event: AgentEvent): void;
  observeToolCall: ObserveAgentToolCall;
  finish(): void;
}

type AgentEventMessage = Extract<AgentEvent, { type: "message_end" }>["message"];

const GENERATION_NAMES = {
  PLAN: "planner.plan",
  FINALIZE: "planner.finalize",
  REPAIR_PLAN: "planner.repair-plan",
  REPAIR_FINALIZE: "planner.repair-finalize",
} as const;

function telemetrySha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeTelemetryIdentifier(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 160);
  return normalized || fallback;
}

function modelParameters(options: AgentModelCallObservation["options"]): Record<string, string | number> {
  const source = (options ?? {}) as Record<string, unknown>;
  const allowed = ["toolChoice", "temperature", "maxTokens", "topP", "reasoningEffort"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") return [[key, value]];
    if (typeof value === "boolean") return [[key, String(value)]];
    return [];
  }));
}

function telemetryAssistantContent(content: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return content.map((item) => {
    if (item["type"] === "toolCall") {
      return {
        type: "tool_call",
        id: safeTelemetryIdentifier(String(item["id"] ?? ""), "missing-tool-call-id"),
        name: safeTelemetryIdentifier(String(item["name"] ?? ""), "unknown-tool"),
        arguments: telemetryContent(item["arguments"] ?? {}),
      };
    }
    if (item["type"] === "thinking") return { type: "thinking", contentCaptured: false };
    return { type: String(item["type"] ?? "text"), content: telemetryContent(item["text"] ?? item) };
  });
}

function telemetryChatMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: telemetryContent(message.content) };
  if (message.role === "toolResult") {
    return {
      role: "tool",
      toolCallId: safeTelemetryIdentifier(message.toolCallId, "missing-tool-call-id"),
      name: safeTelemetryIdentifier(message.toolName, "unknown-tool"),
      isError: message.isError,
      content: telemetryContent(message.content),
    };
  }
  return {
    role: "assistant",
    content: telemetryAssistantContent(message.content as unknown as Array<Record<string, unknown>>),
  };
}

function telemetryModelInput(call: AgentModelCallObservation): Record<string, unknown> {
  return {
    system: {
      role: "system",
      content: telemetryContent(call.context.systemPrompt ?? ""),
    },
    messages: call.context.messages.map((message) => telemetryChatMessage(message)),
    tools: (call.context.tools ?? []).map((tool) => ({
      name: safeTelemetryIdentifier(tool.name, "unknown-tool"),
      description: telemetryContent(tool.description),
      parameters: telemetryContent(tool.parameters),
    })),
  };
}

function precedingToolCallIds(call: AgentModelCallObservation): string[] {
  return call.context.messages.flatMap((message) => message.role === "toolResult"
    ? [safeTelemetryIdentifier(message.toolCallId, "missing-tool-call-id")]
    : []).slice(-8);
}

function generationUsage(message: AssistantMessage): {
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
} {
  const usage = message.usage;
  const reasoning = Math.min(usage.output, Math.max(0, usage.reasoning ?? 0));
  const ordinaryOutput = Math.max(0, usage.output - reasoning);
  const outputCost = usage.output > 0 ? usage.cost.output * (ordinaryOutput / usage.output) : usage.cost.output;
  const reasoningCost = Math.max(0, usage.cost.output - outputCost);
  return {
    usageDetails: {
      input: usage.input,
      output: ordinaryOutput,
      ...(reasoning > 0 ? { output_reasoning: reasoning } : {}),
      ...(usage.cacheRead > 0 ? { input_cached: usage.cacheRead } : {}),
      ...(usage.cacheWrite > 0 ? { input_cache_write: usage.cacheWrite } : {}),
      total: usage.totalTokens,
    },
    costDetails: {
      input: usage.cost.input,
      output: outputCost,
      ...(reasoning > 0 ? { output_reasoning: reasoningCost } : {}),
      ...(usage.cacheRead > 0 ? { input_cached: usage.cost.cacheRead } : {}),
      ...(usage.cacheWrite > 0 ? { input_cache_write: usage.cost.cacheWrite } : {}),
      total: usage.cost.total,
    },
  };
}

export function createAgentEventObserver(options: AgentEventObserverOptions): AgentEventObserver {
  let generation: LangfuseGeneration | null = null;
  let activeCall: AgentModelCallObservation | null = null;
  const startedTools = new Map<string, string>();
  const observedTools = new Map<string, string>();
  const endedTools = new Map<string, string>();
  let duplicateToolEvent = false;
  const finishGeneration = (message?: AgentEventMessage): void => {
    if (!generation) return;
    if (message?.role === "assistant") {
      const assistant = message as AssistantMessage;
      generation.update({
        output: telemetryChatMessage(assistant),
        model: assistant.responseModel ?? assistant.model,
        ...generationUsage(assistant),
        metadata: {
          provider: assistant.provider,
          api: assistant.api,
          stopReason: assistant.stopReason,
          responseModel: assistant.responseModel ?? assistant.model,
          responseIdPresent: Boolean(assistant.responseId),
          inferenceIndex: activeCall?.inferenceIndex ?? 0,
          phase: activeCall?.phase ?? "UNKNOWN",
          promptName: options.promptName,
          promptVersion: options.promptVersion,
          promptSha256: options.promptSha256,
        },
        ...(assistant.stopReason === "error" || assistant.stopReason === "aborted"
          ? { level: "ERROR" as const, statusMessage: telemetryErrorCode(new Error(assistant.errorMessage ?? assistant.stopReason), "MODEL_INFERENCE_FAILED") }
          : {}),
      });
    } else {
      generation.update({ level: "WARNING", statusMessage: "MODEL_STREAM_INCOMPLETE" });
    }
    generation.end();
    generation = null;
    activeCall = null;
  };
  return {
    onModelCall: (call) => {
      finishGeneration();
      activeCall = call;
      const contextSha256 = telemetrySha256(call.context);
      const toolSchemaSha256 = telemetrySha256(call.context.tools ?? []);
      generation = startObservation(GENERATION_NAMES[call.phase], {
        input: telemetryModelInput(call),
        model: String(call.model.id),
        modelParameters: modelParameters(call.options),
        ...(options.promptLink ? { prompt: options.promptLink } : {}),
        metadata: {
          provider: String(call.model.provider),
          api: String(call.model.api),
          inferenceIndex: call.inferenceIndex,
          phase: call.phase,
          trigger: call.inferenceIndex === 1 ? "USER_MESSAGE" : "TOOL_RESULT_OR_REPAIR",
          precedingToolCallIds: precedingToolCallIds(call),
          contextSha256,
          toolSchemaSha256,
          promptName: options.promptName,
          promptVersion: options.promptVersion,
          promptSha256: options.promptSha256,
        },
      }, { asType: "generation" as const });
    },
    onEvent: (event) => {
      if (event.type === "message_start" && event.message.role === "assistant" && generation) {
        generation.update({ completionStartTime: new Date() });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        finishGeneration(event.message);
      } else if (event.type === "turn_end" && generation) {
        finishGeneration(event.message);
      } else if (event.type === "tool_execution_start") {
        const id = safeTelemetryIdentifier(event.toolCallId, "missing-tool-call-id");
        if (startedTools.has(id)) duplicateToolEvent = true;
        startedTools.set(id, safeTelemetryIdentifier(event.toolName, "unknown-tool"));
      } else if (event.type === "tool_execution_end") {
        const id = safeTelemetryIdentifier(event.toolCallId, "missing-tool-call-id");
        if (endedTools.has(id)) duplicateToolEvent = true;
        endedTools.set(id, safeTelemetryIdentifier(event.toolName, "unknown-tool"));
      }
    },
    observeToolCall: async (call, operation) => {
      const toolCallId = safeTelemetryIdentifier(call.toolCallId, "missing-tool-call-id");
      const toolName = safeTelemetryIdentifier(call.toolName, "unknown-tool");
      if (observedTools.has(toolCallId)) duplicateToolEvent = true;
      observedTools.set(toolCallId, toolName);
      return startActiveObservation(
        `agent.tool.${toolName}`,
        async (observation) => {
          observation.update({
            input: {
              toolCallId,
              toolName,
              arguments: telemetryContent(call.arguments),
            },
            metadata: {
              toolCallId,
              toolName,
              inferenceIndex: call.inferenceIndex,
              phase: call.phase,
            },
          });
          try {
            const result = await operation();
            const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
            observation.update({
              output: {
                toolCallId,
                toolName,
                modelVisibleResult: telemetryContent(result),
                internalExecutionSummary: {
                  contentBlockCount: Array.isArray(resultRecord["content"]) ? resultRecord["content"].length : 0,
                  detailKeys: resultRecord["details"] && typeof resultRecord["details"] === "object"
                    ? Object.keys(resultRecord["details"] as Record<string, unknown>).sort()
                    : [],
                  terminate: resultRecord["terminate"] === true,
                },
              },
            });
            return result;
          } catch (error) {
            observation.update({
              level: "ERROR",
              statusMessage: telemetryErrorCode(error, "AGENT_TOOL_EXECUTION_FAILED"),
              output: { toolCallId, toolName, errorCode: telemetryErrorCode(error, "AGENT_TOOL_EXECUTION_FAILED") },
            });
            throw error;
          }
        },
        { asType: "tool" },
      );
    },
    finish: () => {
      finishGeneration();
      const ids = new Set([...startedTools.keys(), ...observedTools.keys(), ...endedTools.keys()]);
      const mismatched = [...ids].filter((id) => {
        const started = startedTools.get(id);
        const observed = observedTools.get(id);
        const ended = endedTools.get(id);
        return !started || !observed || !ended || started !== observed || observed !== ended;
      });
      if (ids.size > 0 || duplicateToolEvent || mismatched.length > 0) {
        recordGuardrailDecision("validate-agent-tool-causality", !duplicateToolEvent && mismatched.length === 0, {
          startedToolCalls: startedTools.size,
          observedToolCalls: observedTools.size,
          endedToolCalls: endedTools.size,
          duplicateToolEvent,
          mismatchedToolCallIds: mismatched.slice(0, 8),
        });
      }
    },
  };
}


