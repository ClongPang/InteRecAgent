import { createHmac } from "node:crypto";

import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import {
  metrics,
  SpanStatusCode,
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

export function resolveTelemetryConfig(environment: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const publicKey = optionalValue(environment["LANGFUSE_PUBLIC_KEY"]);
  const secretKey = optionalValue(environment["LANGFUSE_SECRET_KEY"]);
  if (Boolean(publicKey) !== Boolean(secretKey)) throw new Error("LANGFUSE_CREDENTIALS_INCOMPLETE");
  const baseUrl = optionalValue(environment["LANGFUSE_BASE_URL"]);
  const release = optionalValue(environment["LANGFUSE_RELEASE"]);
  const metricsEndpoint = optionalValue(environment["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]);
  const pseudonymKey = optionalValue(environment["INTEREC_TELEMETRY_PSEUDONYM_KEY"]);
  if (publicKey && secretKey && !pseudonymKey) throw new Error("INTEREC_TELEMETRY_PSEUDONYM_KEY_REQUIRED");
  return {
    langfuseEnabled: Boolean(publicKey && secretKey),
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    environment: normalizeEnvironment(environment["LANGFUSE_TRACING_ENVIRONMENT"]),
    ...(release ? { release } : {}),
    captureContent: environment["INTEREC_LANGFUSE_CAPTURE_CONTENT"]?.toLowerCase() === "true",
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
  if (environment["INTEREC_LANGFUSE_CAPTURE_CONTENT"]?.toLowerCase() !== "true") {
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

export function telemetryErrorCode(error: unknown, fallback = "UNEXPECTED_ERROR"): string {
  if (!(error instanceof Error)) return fallback;
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
}

export interface ConversationTurnObservation {
  turnId: string;
  conversationId: string;
  tenantId: string;
  ownerId: string;
  attempt: number;
  currentUserMessages: string[];
}

export async function observeConversationTurn(
  turn: ConversationTurnObservation,
  operation: () => Promise<TurnObservationOutcome>,
): Promise<TurnObservationOutcome> {
  const config = resolveTelemetryConfig();
  return propagateAttributes(
    {
      traceName: "shopping-recommendation-turn",
      ...(config.pseudonymKey ? { userId: pseudonymousUserId(turn.tenantId, turn.ownerId, config.pseudonymKey) } : {}),
      sessionId: turn.conversationId,
      version: SERVICE_VERSION,
      environment: config.environment,
      tags: ["pi-agent", "shopping-recommendation"],
      metadata: {
        turnId: turn.turnId,
        attempt: String(turn.attempt),
        engine: "pi-agent",
      },
    },
    () => startActiveObservation(
      "shopping-recommendation-turn",
      async (observation) => {
        observation.update({
          input: telemetryContent({ messages: turn.currentUserMessages }),
          metadata: {
            turnId: turn.turnId,
            conversationId: turn.conversationId,
            attempt: turn.attempt,
            contentCaptureEnabled: config.captureContent,
          },
        });
        try {
          const outcome = await operation();
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
      { asType: "agent" },
    ),
  );
}

export async function observeTool<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  summarizeOutput: (result: T) => unknown,
): Promise<T> {
  return startActiveObservation(
    `tool.${name}`,
    async (observation) => {
      observation.update({ input: telemetryContent(input), metadata: { toolName: name } });
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
): Promise<{ forceFlush(): Promise<void>; shutdown(): Promise<void>; langfuseEnabled: boolean }> {
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
  return {
    forceFlush: async () => {
      await Promise.all([
        ...spanProcessors.map((processor) => processor.forceFlush()),
        ...metricReaders.map((reader) => reader.forceFlush()),
      ]);
    },
    shutdown: () => sdk.shutdown(),
    langfuseEnabled: config.langfuseEnabled,
  };
}
