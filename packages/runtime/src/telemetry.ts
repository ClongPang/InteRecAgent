import { createHash, createHmac } from "node:crypto";

import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import {
  getActiveSpanId,
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
  startObservation,
  type LangfuseGeneration,
} from "@langfuse/tracing";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  AgentModelCallObservation,
  AgentToolCallObservation,
  ObserveAgentToolCall,
} from "@interec/agent";
import {
  metrics,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableCallback,
  type ObservableGauge,
  type UpDownCounter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const SERVICE_VERSION = "0.2.0";
const MAX_CAPTURED_CONTENT_CHARS = 20_000;

export interface TelemetryConfig {
  langfuseEnabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment: string;
  release?: string;
  captureContent: boolean;
  pseudonymKey?: string;
  metricsEndpoint?: string;
}

interface TelemetryDependencies {
  langfuseExporter?: SpanExporter;
  metricReader?: MetricReader;
}

export interface TurnObservationOutcome {
  status: string;
  committed: boolean;
  errorCode?: string;
}

export interface TelemetryLifecycleOptions {
  strict?: boolean;
}

export interface TelemetryLifecycleResult {
  failures: string[];
}

export interface TelemetryRuntime {
  forceFlush(options?: TelemetryLifecycleOptions): Promise<TelemetryLifecycleResult>;
  shutdown(options?: TelemetryLifecycleOptions): Promise<TelemetryLifecycleResult>;
  langfuseEnabled: boolean;
}

class DeferredHistogram {
  private instrument: Histogram | null = null;
  public bind(instrument: Histogram): void { this.instrument = instrument; }
  public record(value: number, attributes?: Attributes): void { this.instrument?.record(value, attributes); }
}

class DeferredCounter {
  private instrument: Counter | null = null;
  public bind(instrument: Counter): void { this.instrument = instrument; }
  public add(value: number, attributes?: Attributes): void { this.instrument?.add(value, attributes); }
}

class DeferredUpDownCounter {
  private instrument: UpDownCounter | null = null;
  public bind(instrument: UpDownCounter): void { this.instrument = instrument; }
  public add(value: number, attributes?: Attributes): void { this.instrument?.add(value, attributes); }
}

class DeferredObservableGauge {
  private instrument: ObservableGauge | null = null;
  private readonly callbacks = new Set<ObservableCallback>();
  public bind(instrument: ObservableGauge): void {
    if (this.instrument) for (const callback of this.callbacks) this.instrument.removeCallback(callback);
    this.instrument = instrument;
    for (const callback of this.callbacks) instrument.addCallback(callback);
  }
  public addCallback(callback: ObservableCallback): void {
    this.callbacks.add(callback);
    this.instrument?.addCallback(callback);
  }
  public removeCallback(callback: ObservableCallback): void {
    this.callbacks.delete(callback);
    this.instrument?.removeCallback(callback);
  }
}

export const runtimeMetrics = {
  turnDuration: new DeferredHistogram(),
  queueWait: new DeferredHistogram(),
  queueDepth: new DeferredObservableGauge(),
  apiEnqueueDuration: new DeferredHistogram(),
  apiProjectionDuration: new DeferredHistogram(),
  sseLag: new DeferredHistogram(),
  sseConnections: new DeferredUpDownCounter(),
  providerDuration: new DeferredHistogram(),
  providerErrors: new DeferredCounter(),
  candidateCacheLookups: new DeferredCounter(),
  feedbackEvents: new DeferredCounter(),
  terminalTurns: new DeferredCounter(),
  outboxPublished: new DeferredCounter(),
  outboxFailures: new DeferredCounter(),
  outboxDeadLetters: new DeferredCounter(),
  outboxBacklog: new DeferredObservableGauge(),
  fenceRejectedWrites: new DeferredCounter(),
  claimValidationFailures: new DeferredCounter(),
  safetyBlocks: new DeferredCounter(),
  evidenceBlocks: new DeferredCounter(),
  invokeAgentDuration: new DeferredHistogram(),
  inferenceCalls: new DeferredHistogram(),
  toolCalls: new DeferredHistogram(),
  telemetryLinkFailures: new DeferredCounter(),
};

function bindRuntimeMetrics(): void {
  const meter = metrics.getMeter("interec-agent", SERVICE_VERSION);
  const instruments = {
    turnDuration: meter.createHistogram("rec_agent.turn.duration", { unit: "s" }),
    queueWait: meter.createHistogram("rec_agent.queue.wait.duration", { unit: "s" }),
    queueDepth: meter.createObservableGauge("rec_agent.queue.depth", { unit: "{turn}" }),
    apiEnqueueDuration: meter.createHistogram("rec_agent.api.enqueue.duration", { unit: "s" }),
    apiProjectionDuration: meter.createHistogram("rec_agent.api.projection.duration", { unit: "s" }),
    sseLag: meter.createHistogram("rec_agent.sse.lag.duration", { unit: "s" }),
    sseConnections: meter.createUpDownCounter("rec_agent.sse.connections", { unit: "{connection}" }),
    providerDuration: meter.createHistogram("rec_agent.provider.request.duration", { unit: "s" }),
    providerErrors: meter.createCounter("rec_agent.provider.errors", { unit: "{error}" }),
    candidateCacheLookups: meter.createCounter("rec_agent.candidate_cache.lookups", { unit: "{lookup}" }),
    feedbackEvents: meter.createCounter("rec_agent.feedback.events", { unit: "{event}" }),
    terminalTurns: meter.createCounter("rec_agent.turn.terminal", { unit: "{turn}" }),
    outboxPublished: meter.createCounter("rec_agent.outbox.published", { unit: "{message}" }),
    outboxFailures: meter.createCounter("rec_agent.outbox.failures", { unit: "{failure}" }),
    outboxDeadLetters: meter.createCounter("rec_agent.outbox.dead_letters", { unit: "{message}" }),
    outboxBacklog: meter.createObservableGauge("rec_agent.outbox.backlog", { unit: "{message}" }),
    fenceRejectedWrites: meter.createCounter("rec_agent.fence.rejected_writes", { unit: "{write}" }),
    claimValidationFailures: meter.createCounter("rec_agent.claim_validation_failures", { unit: "{failure}" }),
    safetyBlocks: meter.createCounter("rec_agent.safety_blocks", { unit: "{block}" }),
    evidenceBlocks: meter.createCounter("rec_agent.evidence_blocks", { unit: "{block}" }),
    invokeAgentDuration: meter.createHistogram("gen_ai.invoke_agent.duration", { unit: "s" }),
    inferenceCalls: meter.createHistogram("gen_ai.invoke_agent.inference_calls", { unit: "{call}" }),
    toolCalls: meter.createHistogram("gen_ai.invoke_agent.tool_calls", { unit: "{call}" }),
    telemetryLinkFailures: meter.createCounter("rec_agent.telemetry.link_failures", { unit: "{failure}" }),
  };
  for (const key of Object.keys(runtimeMetrics) as Array<keyof typeof runtimeMetrics>) {
    runtimeMetrics[key].bind(instruments[key] as never);
  }
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEnvironment(value: string | undefined): string {
  const normalized = (value ?? "development")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!normalized) return "development";
  return normalized.startsWith("langfuse") ? `app-${normalized}`.slice(0, 40) : normalized;
}

function contentCaptureAuthorized(environment: NodeJS.ProcessEnv): boolean {
  return environment["INTEREC_LANGFUSE_CAPTURE_CONTENT"]?.toLowerCase() === "true"
    && environment["INTEREC_LANGFUSE_CAPTURE_CONSENT"] === "authorized-redacted-content";
}

export function resolveTelemetryConfig(environment: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const publicKey = optionalValue(environment["LANGFUSE_PUBLIC_KEY"]);
  const secretKey = optionalValue(environment["LANGFUSE_SECRET_KEY"]);
  if (Boolean(publicKey) !== Boolean(secretKey)) throw new Error("LANGFUSE_CREDENTIALS_INCOMPLETE");
  const baseUrl = optionalValue(environment["LANGFUSE_BASE_URL"]);
  const release = optionalValue(environment["LANGFUSE_RELEASE"]);
  const metricsEndpoint = optionalValue(environment["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]);
  const pseudonymKey = optionalValue(environment["INTEREC_TELEMETRY_PSEUDONYM_KEY"]);
  if (publicKey && secretKey && !pseudonymKey) throw new Error("INTEREC_TELEMETRY_PSEUDONYM_KEY_REQUIRED");
  if (environment["INTEREC_LANGFUSE_CAPTURE_CONTENT"]?.toLowerCase() === "true" && !contentCaptureAuthorized(environment)) {
    throw new Error("INTEREC_LANGFUSE_CAPTURE_CONSENT_REQUIRED");
  }
  return {
    langfuseEnabled: Boolean(publicKey && secretKey),
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    environment: normalizeEnvironment(environment["LANGFUSE_TRACING_ENVIRONMENT"]),
    ...(release ? { release } : {}),
    captureContent: contentCaptureAuthorized(environment),
    ...(pseudonymKey ? { pseudonymKey } : {}),
    ...(metricsEndpoint ? { metricsEndpoint } : {}),
  };
}

const SENSITIVE_KEY = /(?:api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|cookie)/i;

function redactString(value: string): string {
  return value
    .replace(/("(?:api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)-(?:lf-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]");
}

export function redactTelemetryData(data: unknown): unknown {
  if (typeof data === "string") return redactString(data);
  if (Array.isArray(data)) return data.map((item) => redactTelemetryData(item));
  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactTelemetryData(value),
      ]),
    );
  }
  return data;
}

export function telemetryContent(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!contentCaptureAuthorized(environment)) {
    return { contentCaptured: false };
  }
  const redacted = redactTelemetryData(value);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= MAX_CAPTURED_CONTENT_CHARS) return redacted;
    return {
      contentCaptured: true,
      truncated: true,
      json: serialized.slice(0, MAX_CAPTURED_CONTENT_CHARS),
    };
  } catch {
    return { contentCaptured: true, serializationFailed: true };
  }
}

export function pseudonymousUserId(tenantId: string, ownerId: string, key: string): string {
  if (key.length < 32) throw new Error("INTEREC_TELEMETRY_PSEUDONYM_KEY_INVALID");
  return createHmac("sha256", key).update(tenantId).update("\0").update(ownerId).digest("hex").slice(0, 32);
}

export function telemetryTraceIdForTurn(conversationId: string, clientTurnId: string): string {
  return createHash("sha256")
    .update("interec-turn-trace-v1")
    .update("\0")
    .update(conversationId)
    .update("\0")
    .update(clientTurnId)
    .digest("hex")
    .slice(0, 32);
}

function validTraceId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{32}$/.test(value) && value !== "0".repeat(32));
}

function validSpanId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{16}$/.test(value) && value !== "0".repeat(16));
}

function parentSpanIdForTrace(traceId: string): string {
  const spanId = createHash("sha256").update("interec-turn-parent-v1").update("\0").update(traceId).digest("hex").slice(0, 16);
  return spanId === "0".repeat(16) ? `1${spanId.slice(1)}` : spanId;
}

function pseudonymousSessionId(conversationId: string, key: string): string {
  return createHmac("sha256", key).update("session").update("\0").update(conversationId).digest("hex").slice(0, 32);
}

export function telemetryErrorCode(error: unknown, fallback = "UNEXPECTED_ERROR"): string {
  if (!(error instanceof Error)) return fallback;
  const coded = (error as Error & { code?: unknown }).code;
  if (typeof coded === "string" && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(coded)) return coded.slice(0, 100);
  const explicit = error.message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
  if (explicit) return explicit.slice(0, 100);
  const named = error.name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
  return named && named !== "ERROR" ? named.slice(0, 100) : fallback;
}

export interface SafetyBoundaryClassification {
  claimValidation: boolean;
  evidence: boolean;
  safety: boolean;
}

export function classifySafetyBoundary(errorCode: string): SafetyBoundaryClassification {
  const code = errorCode.toUpperCase();
  const claimValidation = /CLAIM|ASSISTANT_ENVELOPE/.test(code);
  const evidence = /EVIDENCE|PROOF|QUALIFICATION|ARTIFACT|SOURCE_FACT|FX_|MARKET_CONFLICT|PRODUCT_IDENTITY/.test(code);
  const safety = claimValidation || evidence || /HARD_CONSTRAINT|WORKING_SET|REFERENT|OFFER_|UNNECESSARY_PROVIDER_RESEARCH|RESEARCH_BEFORE_CLARIFICATION|RESEARCH_BLOCKED|UI_FOCUS/.test(code);
  return { claimValidation, evidence, safety };
}

export function recordSafetyBoundary(errorCode: string): void {
  const classification = classifySafetyBoundary(errorCode);
  if (classification.claimValidation) runtimeMetrics.claimValidationFailures.add(1);
  if (classification.evidence) runtimeMetrics.evidenceBlocks.add(1);
  if (classification.safety) runtimeMetrics.safetyBlocks.add(1);
  if (classification.safety) recordGuardrailDecision("enforce-safety-boundary", false, {
    errorCode,
    claimValidation: classification.claimValidation,
    evidence: classification.evidence,
  });
}

export function recordGuardrailDecision(
  name: string,
  passed: boolean,
  metadata: Record<string, unknown> = {},
): void {
  try {
    const observation = startObservation(name, {
      input: { check: name },
      output: { passed },
      metadata: redactTelemetryData(metadata) as Record<string, unknown>,
      ...(!passed ? { level: "WARNING" as const, statusMessage: "BLOCKED" } : {}),
    }, { asType: "guardrail" });
    observation.end();
  } catch {
    // Guardrail observability must never change the guarded business outcome.
  }
}

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

export interface ConversationTurnObservation {
  turnId: string;
  conversationId: string;
  tenantId: string;
  ownerId: string;
  attempt: number;
  currentUserMessages: string[];
  traceId?: string;
  traceRootObservationId?: string;
  correlation?: {
    datasetRunId?: string;
    datasetRunName?: string;
    datasetItemId?: string;
    experimentWrapperTraceId?: string;
    trialId?: string;
    taskId?: string;
    runIndex?: number;
    turnIndex?: number;
  };
}

export interface ActiveTurnObservation {
  traceId?: string;
  rootObservationId?: string;
}

function traceCorrelationMetadata(correlation: ConversationTurnObservation["correlation"]): Record<string, string> {
  return Object.fromEntries(Object.entries(correlation ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, String(value)]]));
}

export async function observeConversationTurn(
  turn: ConversationTurnObservation,
  operation: (active: ActiveTurnObservation) => Promise<TurnObservationOutcome>,
): Promise<TurnObservationOutcome> {
  const config = resolveTelemetryConfig();
  const traceId = validTraceId(turn.traceId) ? turn.traceId : undefined;
  return propagateAttributes(
    {
      traceName: "conversation-turn",
      ...(config.pseudonymKey ? { userId: pseudonymousUserId(turn.tenantId, turn.ownerId, config.pseudonymKey) } : {}),
      ...(config.pseudonymKey ? { sessionId: pseudonymousSessionId(turn.conversationId, config.pseudonymKey) } : {}),
      version: SERVICE_VERSION,
      environment: config.environment,
      tags: ["conversation-agent", "pi-agent"],
      metadata: {
        turnId: turn.turnId,
        attempt: String(turn.attempt),
        engine: "pi-agent",
        ...traceCorrelationMetadata(turn.correlation),
      },
    },
    () => startActiveObservation(
      "execute-turn-attempt",
      async (observation) => {
        const activeTraceId = getActiveTraceId();
        const activeSpanId = getActiveSpanId();
        const active: ActiveTurnObservation = {
          ...(activeTraceId ? { traceId: activeTraceId } : {}),
          ...(activeSpanId ? { rootObservationId: activeSpanId } : {}),
        };
        observation.update({
          input: telemetryContent({ messages: turn.currentUserMessages }),
          metadata: {
            turnId: turn.turnId,
            attempt: turn.attempt,
            contentCaptureEnabled: config.captureContent,
            ...traceCorrelationMetadata(turn.correlation),
          },
        });
        try {
          const outcome = await operation(active);
          observation.update({
            output: outcome,
            ...(outcome.status === "COMPLETED" ? {} : { level: "ERROR" as const, statusMessage: outcome.errorCode ?? outcome.status }),
          });
          return outcome;
        } catch (error) {
          observation.update({
            level: "ERROR",
            statusMessage: telemetryErrorCode(error),
            output: { status: "FAILED", committed: false, errorCode: telemetryErrorCode(error) },
          });
          throw error;
        }
      },
      {
        asType: "agent",
        ...(traceId ? {
          parentSpanContext: {
            traceId,
            spanId: validSpanId(turn.traceRootObservationId) ? turn.traceRootObservationId : parentSpanIdForTrace(traceId),
            traceFlags: TraceFlags.SAMPLED,
          },
        } : {}),
      },
    ),
  );
}

export interface TurnEnqueueObservation {
  traceId: string;
  conversationId: string;
  tenantId: string;
  ownerId: string;
  operation: "accept_turn" | "retry_turn";
  inputType: string;
}

export interface ActiveTurnEnqueueObservation {
  traceId: string;
  rootObservationId?: string;
}

export async function observeTurnEnqueue<T>(
  turn: TurnEnqueueObservation,
  operation: (active: ActiveTurnEnqueueObservation) => Promise<T>,
): Promise<T> {
  const config = resolveTelemetryConfig();
  const traceId = validTraceId(turn.traceId) ? turn.traceId : undefined;
  return propagateAttributes({
    traceName: "conversation-turn",
    ...(config.pseudonymKey ? { userId: pseudonymousUserId(turn.tenantId, turn.ownerId, config.pseudonymKey) } : {}),
    ...(config.pseudonymKey ? { sessionId: pseudonymousSessionId(turn.conversationId, config.pseudonymKey) } : {}),
    version: SERVICE_VERSION,
    environment: config.environment,
    tags: ["conversation-agent", "api"],
    metadata: { operation: turn.operation },
  }, () => startActiveObservation("conversation-turn", async (root) => {
    const activeTraceId = getActiveTraceId();
    const rootObservationId = getActiveSpanId();
    const active: ActiveTurnEnqueueObservation = {
      traceId: activeTraceId ?? traceId ?? turn.traceId,
      ...(rootObservationId ? { rootObservationId } : {}),
    };
    root.update({
      input: { operation: turn.operation, inputType: turn.inputType },
      metadata: { operation: turn.operation, asynchronous: true },
    });
    try {
      const result = await startActiveObservation("enqueue-turn", async (observation) => {
        observation.update({ input: { operation: turn.operation, inputType: turn.inputType } });
        try {
          const accepted = await operation(active);
          observation.update({ output: { accepted: true } });
          return accepted;
        } catch (error) {
          observation.update({ level: "ERROR", statusMessage: telemetryErrorCode(error), output: { accepted: false } });
          throw error;
        }
      });
      root.update({ output: { accepted: true, asynchronousExecutionPending: true } });
      return result;
    } catch (error) {
      root.update({ level: "ERROR", statusMessage: telemetryErrorCode(error), output: { accepted: false } });
      throw error;
    }
  }, {
    asType: "chain",
    ...(traceId ? {
      parentSpanContext: {
        traceId,
        spanId: parentSpanIdForTrace(traceId),
        traceFlags: TraceFlags.SAMPLED,
      },
    } : {}),
  }));
}

export async function observeTool<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  summarizeOutput: (result: T) => unknown,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  return startActiveObservation(
    `tool.${name}`,
    async (observation) => {
      observation.update({ input: telemetryContent(input), metadata: { toolName: name, ...redactTelemetryData(metadata) as Record<string, unknown> } });
      try {
        const result = await operation();
        observation.update({ output: redactTelemetryData(summarizeOutput(result)) });
        return result;
      } catch (error) {
        observation.update({ level: "ERROR", statusMessage: telemetryErrorCode(error) });
        throw error;
      }
    },
    { asType: "tool" },
  );
}

export async function observeHostStep<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  summarizeOutput: (result: T) => unknown,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  return startActiveObservation(
    `host.${name}`,
    async (observation) => {
      observation.update({
        input: telemetryContent(input),
        metadata: { hostStep: name, ...redactTelemetryData(metadata) as Record<string, unknown> },
      });
      try {
        const result = await operation();
        observation.update({ output: redactTelemetryData(summarizeOutput(result)) });
        return result;
      } catch (error) {
        observation.update({ level: "ERROR", statusMessage: telemetryErrorCode(error) });
        throw error;
      }
    },
    { asType: "span" },
  );
}

export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
): Promise<T> {
  return trace.getTracer("interec-agent", SERVICE_VERSION).startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation();
    } catch (error) {
      span.recordException({ name: "Error", message: telemetryErrorCode(error) });
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function startTelemetry(
  serviceName: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: TelemetryDependencies = {},
): Promise<TelemetryRuntime> {
  const config = resolveTelemetryConfig(environment);
  const spanProcessors: SpanProcessor[] = [];
  if (config.langfuseEnabled) {
    spanProcessors.push(new LangfuseSpanProcessor({
      publicKey: config.publicKey!,
      secretKey: config.secretKey!,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      environment: config.environment,
      ...(config.release ? { release: config.release } : {}),
      ...(dependencies.langfuseExporter ? { exporter: dependencies.langfuseExporter } : {}),
      mediaUploadEnabled: false,
      mask: ({ data }) => redactTelemetryData(data),
      shouldExportSpan: ({ otelSpan }) =>
        isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name.startsWith("interec-"),
    }));
  }
  const metricReaders = dependencies.metricReader
    ? [dependencies.metricReader]
    : config.metricsEndpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: config.metricsEndpoint }),
            exportIntervalMillis: 10_000,
          }),
        ]
      : [];
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.version": SERVICE_VERSION,
      "deployment.environment.name": config.environment,
    }),
    spanProcessors,
    metricReaders,
  });
  sdk.start();
  bindRuntimeMetrics();
  const settle = async (operations: Array<Promise<unknown>>, options: TelemetryLifecycleOptions = {}): Promise<TelemetryLifecycleResult> => {
    const results = await Promise.allSettled(operations);
    const failures = results.flatMap((result) => result.status === "rejected"
      ? [telemetryErrorCode(result.reason, "TELEMETRY_EXPORT_FAILED")]
      : []);
    if (failures.length > 0) runtimeMetrics.telemetryLinkFailures.add(failures.length, { operation: "export_lifecycle" });
    if (options.strict && failures.length > 0) throw new AggregateError(
      results.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
      `TELEMETRY_LIFECYCLE_FAILED:${failures.join(",")}`,
    );
    return { failures };
  };
  return {
    forceFlush: (options) => settle([
        ...spanProcessors.map((processor) => processor.forceFlush()),
        ...metricReaders.map((reader) => reader.forceFlush()),
      ], options),
    shutdown: (options) => settle([sdk.shutdown()], options),
    langfuseEnabled: config.langfuseEnabled,
  };
}
