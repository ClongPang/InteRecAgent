import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  startActiveObservation,
  startObservation,
  type LangfuseGeneration,
} from "@langfuse/tracing";
import type {
  AgentModelCallObservation,
  ObserveAgentToolCall,
} from "@retail-price/agent";

import { retailPriceEnvironmentValue } from "./environment.js";

import {
  recordGuardrailDecision,
  telemetryContent,
  telemetryErrorCode,
} from "./telemetry-safety.js";
import {
  AgentCausalityLedger,
  buildAgentModelBoundaryManifest,
  traceValueSha256,
} from "./agent-trace-model.js";
import { runtimeMetrics } from "./runtime-metrics.js";
import {
  modelParameters,
  precedingToolCallIds,
  safeTelemetryIdentifier,
  telemetryChatMessage,
  telemetryModelInput,
} from "./agent-trace-rendering.js";

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
  REPAIR_PLAN: "planner.repair-plan",
} as const;

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
  const digestKey = retailPriceEnvironmentValue(process.env, "TELEMETRY_PSEUDONYM_KEY");
  const causality = new AgentCausalityLedger(digestKey);
  const finishGeneration = (message?: AgentEventMessage): void => {
    if (!generation) return;
    if (message?.role === "assistant") {
      const assistant = message as AssistantMessage;
      causality.recordModelOutput(assistant, activeCall?.inferenceIndex ?? 0);
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
      causality.recordModelInput(call);
      const manifest = buildAgentModelBoundaryManifest(call, digestKey);
      generation = startObservation(GENERATION_NAMES[call.phase], {
        input: telemetryModelInput(call),
        model: String(call.model.id),
        modelParameters: modelParameters(call.options),
        ...(options.promptLink ? { prompt: options.promptLink } : {}),
        metadata: {
          provider: String(call.model.provider),
          api: String(call.model.api),
          modelId: String(call.model.id),
          inferenceIndex: call.inferenceIndex,
          phase: call.phase,
          trigger: call.inferenceIndex === 1 ? "USER_MESSAGE" : "TOOL_RESULT_OR_REPAIR",
          precedingToolCallIds: precedingToolCallIds(call),
          ...manifest,
          toolNames: (call.context.tools ?? []).map((tool) => safeTelemetryIdentifier(tool.name, "unknown-tool")),
          toolDefinitions: telemetryContent((call.context.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))),
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
        causality.recordToolStart(event.toolCallId, event.toolName);
      } else if (event.type === "tool_execution_end") {
        causality.recordToolEnd(event);
      }
    },
    observeToolCall: async (call, operation) => {
      const toolCallId = safeTelemetryIdentifier(call.toolCallId, "missing-tool-call-id");
      const toolName = safeTelemetryIdentifier(call.toolName, "unknown-tool");
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
            causality.recordToolObservation(call, result);
            const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
            observation.update({
              output: {
                toolCallId,
                toolName,
                modelVisibleResult: telemetryContent(result),
                modelVisibleResultSha256: traceValueSha256(resultRecord["content"] ?? [], digestKey),
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
            causality.recordToolObservation(call, undefined);
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
      const report = causality.report();
      runtimeMetrics.traceCausalityChecks.add(1, { outcome: report.passed ? "PASS" : "FAIL" });
      const violationCounts: Array<[string, number]> = [
        ["DUPLICATE_TOOL_CALL", report.duplicateToolCallIds.length],
        ["ORPHAN_TOOL_CALL", report.orphanToolCallIds.length],
        ["LIFECYCLE_MISMATCH", report.lifecycleMismatchToolCallIds.length],
        ["RESULT_MISMATCH", report.resultMismatchToolCallIds.length],
        ["UNCONSUMED_TOOL_RESULT", report.unconsumedToolResultIds.length],
      ];
      for (const [failureType, count] of violationCounts) {
        if (count > 0) runtimeMetrics.traceCausalityViolations.add(count, { failure_type: failureType });
      }
      if (report.requestedToolCalls > 0
        || report.startedToolCalls > 0
        || report.observedToolCalls > 0
        || report.endedToolCalls > 0) {
        const safeIds = (ids: string[]) => ids
          .slice(0, 8)
          .map((id) => safeTelemetryIdentifier(id, "missing-tool-call-id"));
        recordGuardrailDecision("validate-agent-tool-causality", report.passed, {
          requestedToolCalls: report.requestedToolCalls,
          startedToolCalls: report.startedToolCalls,
          observedToolCalls: report.observedToolCalls,
          endedToolCalls: report.endedToolCalls,
          consumedToolResults: report.consumedToolResults,
          duplicateToolCallIds: safeIds(report.duplicateToolCallIds),
          orphanToolCallIds: safeIds(report.orphanToolCallIds),
          lifecycleMismatchToolCallIds: safeIds(report.lifecycleMismatchToolCallIds),
          resultMismatchToolCallIds: safeIds(report.resultMismatchToolCallIds),
          unconsumedToolResultIds: safeIds(report.unconsumedToolResultIds),
        });
      }
    },
  };
}
