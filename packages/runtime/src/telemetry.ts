import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import {
  getActiveSpanId,
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import {
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  bindRuntimeMetrics,
  runtimeMetrics,
  TELEMETRY_SERVICE_VERSION as SERVICE_VERSION,
} from "./runtime-metrics.js";
export { runtimeMetrics } from "./runtime-metrics.js";
import {
  parentSpanIdForTrace,
  pseudonymousSessionId,
  pseudonymousUserId,
  redactTelemetryData,
  resolveTelemetryConfig,
  telemetryContent,
  telemetryErrorCode,
  validSpanId,
  validTraceId,
} from "./telemetry-safety.js";
export * from "./telemetry-safety.js";
export * from "./agent-telemetry.js";


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

export async function observeTurnExecutorStep<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  summarizeOutput: (result: T) => unknown,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  return startActiveObservation(
    `turn_executor.${name}`,
    async (observation) => {
      observation.update({
        input: telemetryContent(input),
        metadata: { turnExecutorStep: name, ...redactTelemetryData(metadata) as Record<string, unknown> },
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
