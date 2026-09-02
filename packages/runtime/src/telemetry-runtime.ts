import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
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
import {
  redactTelemetryData,
  resolveTelemetryConfig,
  telemetryErrorCode,
} from "./telemetry-safety.js";

interface TelemetryDependencies {
  langfuseExporter?: SpanExporter;
  metricReader?: MetricReader;
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

export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
): Promise<T> {
  return trace.getTracer("retail-price-agent", SERVICE_VERSION).startActiveSpan(
    name,
    { attributes },
    async (span) => {
      try {
        return await operation();
      } catch (error) {
        span.recordException({ name: "Error", message: telemetryErrorCode(error) });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
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
      shouldExportSpan: ({ otelSpan }) => (
        isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name.startsWith("retail-price-")
      ),
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
  const settle = async (
    operations: Array<Promise<unknown>>,
    options: TelemetryLifecycleOptions = {},
  ): Promise<TelemetryLifecycleResult> => {
    const results = await Promise.allSettled(operations);
    const failures = results.flatMap((result) => result.status === "rejected"
      ? [telemetryErrorCode(result.reason, "TELEMETRY_EXPORT_FAILED")]
      : []);
    if (failures.length > 0) {
      runtimeMetrics.telemetryExportLifecycle.add(failures.length, { action: "export", outcome: "failed" });
    }
    if (options.strict && failures.length > 0) {
      throw new AggregateError(
        results.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
        `TELEMETRY_LIFECYCLE_FAILED:${failures.join(",")}`,
      );
    }
    return { failures };
  };
  return {
    forceFlush: async (options) => {
      const result = await settle([
        ...spanProcessors.map((processor) => processor.forceFlush()),
        ...metricReaders.map((reader) => reader.forceFlush()),
      ], options);
      runtimeMetrics.telemetryExportLifecycle.add(1, {
        action: "force_flush",
        outcome: result.failures.length === 0 ? "succeeded" : "failed",
      });
      return result;
    },
    shutdown: async (options) => {
      const result = await settle([sdk.shutdown()], options);
      runtimeMetrics.telemetryExportLifecycle.add(1, {
        action: "shutdown",
        outcome: result.failures.length === 0 ? "succeeded" : "failed",
      });
      return result;
    },
    langfuseEnabled: config.langfuseEnabled,
  };
}
