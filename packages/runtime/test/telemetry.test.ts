import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import {
  classifySafetyBoundary,
  createAgentEventObserver,
  inSpan,
  observeConversationTurn,
  observeHostStep,
  observeTurnEnqueue,
  observeTool,
  pseudonymousUserId,
  redactTelemetryData,
  resolveTelemetryConfig,
  runtimeMetrics,
  startTelemetry,
  telemetryContent,
  telemetryErrorCode,
  telemetryTraceIdForTurn,
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
      INTEREC_LANGFUSE_CAPTURE_CONSENT: "authorized-redacted-content",
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
    expect(telemetryErrorCode(Object.assign(new Error("opaque domain failure"), { code: "WORKING_SET_REQUIRED" }))).toBe("WORKING_SET_REQUIRED");
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
      traceId: telemetryTraceIdForTurn("22222222-2222-4222-8222-222222222222", "client-turn-1"),
      correlation: {
        datasetRunName: "qualification-rep-1",
        datasetItemId: "dataset-item-1",
        experimentWrapperTraceId: "a".repeat(32),
        trialId: "trial-1",
        taskId: "task-1",
        runIndex: 1,
        turnIndex: 1,
      },
    };
    let traceRootObservationId: string | undefined;
    try {
      await observeTurnEnqueue({
        traceId: turn.traceId,
        conversationId: turn.conversationId,
        tenantId: turn.tenantId,
        ownerId: turn.ownerId,
        operation: "accept_turn",
        inputType: "MESSAGE",
      }, async (active) => {
        traceRootObservationId = active.rootObservationId;
        return { accepted: true };
      });
      await observeConversationTurn({ ...turn, ...(traceRootObservationId ? { traceRootObservationId } : {}) }, async () => {
        const agentObserver = createAgentEventObserver({
          promptName: "test-prompt",
          promptVersion: "test-v1",
          promptSha256: `sha256:${"a".repeat(64)}`,
        });
        const assistantMessage = {
          role: "assistant" as const,
          content: [{ type: "toolCall" as const, id: "call-1", name: "commit_turn_plan", arguments: {} }],
          api: "openai-completions" as const,
          provider: "deepseek" as const,
          model: "deepseek-v4-flash",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 0,
            reasoning: 5,
            totalTokens: 130,
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
          },
          stopReason: "toolUse" as const,
          timestamp: Date.now(),
        };
        agentObserver.onModelCall({
          model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions" } as never,
          context: {
            systemPrompt: "private system prompt",
            messages: [{ role: "user", content: turn.currentUserMessages[0], timestamp: Date.now() }],
            tools: [],
          },
          options: { toolChoice: "required" },
          inferenceIndex: 1,
          phase: "PLAN",
        });
        agentObserver.onEvent({ type: "turn_start" });
        agentObserver.onEvent({ type: "message_start", message: assistantMessage });
        agentObserver.onEvent({ type: "message_end", message: assistantMessage });
        agentObserver.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "commit_turn_plan", args: {} });
        const toolResult = await agentObserver.observeToolCall({
          toolCallId: "call-1",
          toolName: "commit_turn_plan",
          arguments: {},
          inferenceIndex: 1,
          phase: "PLAN",
        }, async () => {
          await observeHostStep("execute-operation", { kind: "RESEARCH_OFFERS" }, () => observeTool(
              "discover_offers",
              { queryVariant: turn.currentUserMessages[0] },
              () => inSpan("buywhere.search", { "rec_agent.market": "US" }, async () => ["offer-1"]),
              (offers) => ({ offerCount: offers.length }),
            ), (offers) => ({ offerCount: offers.length }));
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
        });
        agentObserver.onEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "commit_turn_plan", result: toolResult, isError: false });
        agentObserver.onEvent({ type: "turn_end", message: assistantMessage, toolResults: [] });
        agentObserver.finish();
        return { status: "COMPLETED", committed: true };
      });
      runtimeMetrics.apiEnqueueDuration.record(0.01, { operation: "accept_turn", outcome: "accepted" });
      await telemetry.forceFlush();
      const spans = exporter.getFinishedSpans();
      const names = spans.map((span) => span.name);
      expect(names).toEqual(expect.arrayContaining([
        "enqueue-turn",
        "execute-turn-attempt",
        "planner.plan",
        "agent.tool.commit_turn_plan",
        "host.execute-operation",
        "tool.discover_offers",
        "buywhere.search",
        "validate-agent-tool-causality",
      ]));
      expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
      expect(spans.every((span) => span.spanContext().traceId === turn.traceId)).toBe(true);
      const modelTool = spans.find((span) => span.name === "agent.tool.commit_turn_plan");
      const providerTool = spans.find((span) => span.name === "tool.discover_offers");
      const hostStep = spans.find((span) => span.name === "host.execute-operation");
      const generation = spans.find((span) => span.name === "planner.plan");
      const traceRoot = spans.find((span) => span.name === "conversation-turn");
      const enqueue = spans.find((span) => span.name === "enqueue-turn");
      const agentRoot = spans.find((span) => span.name === "execute-turn-attempt");
      expect(traceRoot).toBeDefined();
      expect(enqueue?.parentSpanContext?.spanId).toBe(traceRoot?.spanContext().spanId);
      expect(agentRoot?.parentSpanContext?.spanId).toBe(traceRoot?.spanContext().spanId);
      expect(modelTool).toBeDefined();
      expect(hostStep?.parentSpanContext?.spanId).toBe(modelTool?.spanContext().spanId);
      expect(providerTool?.parentSpanContext?.spanId).toBe(hostStep?.spanContext().spanId);
      expect(JSON.stringify(modelTool?.attributes)).toContain("call-1");
      expect(JSON.stringify(generation?.attributes)).toContain("PLAN");
      expect(JSON.stringify(generation?.attributes)).toContain("contextSha256");
      expect(JSON.stringify(generation?.attributes)).toContain("toolSchemaSha256");
      const exported = JSON.stringify(spans.map((span) => span.attributes));
      const resourceAttributes = JSON.stringify(spans.map((span) => span.resource.attributes));
      expect(exported).not.toContain("private query");
      expect(exported).not.toContain("buyer@example.com");
      expect(exported).not.toContain(turn.conversationId);
      expect(exported).not.toContain("sk-lf-should-not-leave");
      expect(exported).toContain(pseudonymousUserId(turn.tenantId, turn.ownerId, "test-pseudonym-key-with-at-least-32-bytes"));
      expect(exported).toContain(turn.turnId);
      expect(exported).toContain("qualification-rep-1");
      expect(exported).toContain("dataset-item-1");
      expect(exported).toContain("trial-1");
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
