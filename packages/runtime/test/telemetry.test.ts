import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import {
  classifySafetyBoundary,
  inSpan,
  observeConversationTurn,
  observeTool,
  pseudonymousUserId,
  redactTelemetryData,
  resolveTelemetryConfig,
  runtimeMetrics,
  startTelemetry,
  telemetryContent,
  telemetryErrorCode,
} from "../src/telemetry.js";

describe("Langfuse telemetry", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires a complete Langfuse credential pair and keeps content capture opt-in", () => {
    expect(resolveTelemetryConfig({ LANGFUSE_TRACING_ENVIRONMENT: "Development" })).toMatchObject({
      langfuseEnabled: false,
      environment: "development",
      captureContent: false,
    });
    expect(() => resolveTelemetryConfig({ LANGFUSE_PUBLIC_KEY: "pk-lf-test" })).toThrow(
      "LANGFUSE_CREDENTIALS_INCOMPLETE",
    );
    expect(resolveTelemetryConfig({
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: "https://langfuse.example.test",
      LANGFUSE_TRACING_ENVIRONMENT: "Staging CN",
      INTEREC_LANGFUSE_CAPTURE_CONTENT: "true",
      INTEREC_TELEMETRY_PSEUDONYM_KEY: "test-pseudonym-key-with-at-least-32-bytes",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
    })).toMatchObject({
      langfuseEnabled: true,
      baseUrl: "https://langfuse.example.test",
      environment: "staging-cn",
      captureContent: true,
      metricsEndpoint: "http://collector:4318/v1/metrics",
    });
  });

  it("redacts secrets and personal identifiers before export", () => {
    const redacted = redactTelemetryData({
      apiKey: "secret-value",
      nested: {
        authorization: "Bearer abcdefghijklmnop",
        email: "buyer@example.com",
        payment: "4111 1111 1111 1111",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(redacted)).not.toContain("buyer@example.com");
    expect(JSON.stringify(redacted)).not.toContain("4111 1111 1111 1111");
    expect(telemetryContent({ query: "private query" }, {})).toEqual({ contentCaptured: false });
    expect(telemetryErrorCode(new Error("provider echoed private query"))).toBe("UNEXPECTED_ERROR");
    expect(telemetryErrorCode(new Error("BUYWHERE_HTTP_429"))).toBe("BUYWHERE_HTTP_429");
  });

  it("classifies bounded domain safety failures without treating provider outages as safety incidents", () => {
    expect(classifySafetyBoundary("CLAIM_EVIDENCE_NOT_ALLOWED")).toEqual({ claimValidation: true, evidence: true, safety: true });
    expect(classifySafetyBoundary("UNNECESSARY_PROVIDER_RESEARCH")).toEqual({ claimValidation: false, evidence: false, safety: true });
    expect(classifySafetyBoundary("BUYWHERE_HTTP_503")).toEqual({ claimValidation: false, evidence: false, safety: false });
  });

  it("exports one correlated agent tree without raw content", async () => {
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "test");
    vi.stubEnv("INTEREC_LANGFUSE_CAPTURE_CONTENT", "false");
    vi.stubEnv("INTEREC_TELEMETRY_PSEUDONYM_KEY", "test-pseudonym-key-with-at-least-32-bytes");
    const exporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter();
    const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
    const telemetry = await startTelemetry(
      "interec-telemetry-test",
      {
        LANGFUSE_PUBLIC_KEY: "pk-lf-test-value",
        LANGFUSE_SECRET_KEY: "sk-lf-test-value",
        LANGFUSE_TRACING_ENVIRONMENT: "test",
        INTEREC_TELEMETRY_PSEUDONYM_KEY: "test-pseudonym-key-with-at-least-32-bytes",
      },
      { langfuseExporter: exporter, metricReader },
    );
    const turn = {
      turnId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      tenantId: "tenant-a",
      ownerId: "buyer@example.com",
      attempt: 1,
      currentUserMessages: ["private query sk-lf-should-not-leave"],
    };
    try {
      await observeConversationTurn(turn, async () => {
        await observeTool(
          "discover_offers",
          { queryVariant: turn.currentUserMessages[0] },
          () => inSpan("buywhere.search", { "rec_agent.market": "US" }, async () => ["offer-1"]),
          (offers) => ({ offerCount: offers.length }),
        );
        return { status: "COMPLETED", committed: true };
      });
      runtimeMetrics.apiEnqueueDuration.record(0.01, { operation: "accept_turn", outcome: "accepted" });
      await telemetry.forceFlush();
      const spans = exporter.getFinishedSpans();
      const names = spans.map((span) => span.name);
      expect(names).toEqual(expect.arrayContaining([
        "shopping-recommendation-turn",
        "tool.discover_offers",
        "buywhere.search",
      ]));
      expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
      const exported = JSON.stringify(spans.map((span) => span.attributes));
      const resourceAttributes = JSON.stringify(spans.map((span) => span.resource.attributes));
      expect(exported).not.toContain("private query");
      expect(exported).not.toContain("buyer@example.com");
      expect(exported).not.toContain("sk-lf-should-not-leave");
      expect(exported).toContain(pseudonymousUserId(turn.tenantId, turn.ownerId, "test-pseudonym-key-with-at-least-32-bytes"));
      expect(exported).toContain(turn.turnId);
      expect(resourceAttributes).not.toContain("process.command_args");
      expect(resourceAttributes).not.toContain("process.command_line");
      expect(resourceAttributes).toContain("interec-telemetry-test");
      const metricNames = metricExporter.getMetrics().flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)));
      expect(metricNames).toContain("rec_agent.api.enqueue.duration");
    } finally {
      await telemetry.shutdown();
    }
  });
});
