import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { projectPublishedQuoteLeadSet, resolveQuoteTarget } from "@retail-price/domain";

import { BuyWhereMcpQuoteClient } from "../src/buywhere-mcp-quote-client.js";
import { observeQuoteLookupHost } from "../src/quote-lookup-observability.js";
import { QuoteLookupService } from "../src/quote-lookup-service.js";

import {
  assembleQuoteTurnDecision,
  assertDecisionProvenanceNonPii,
  buildQuoteTurnDecisionProvenance,
  deriveTargetLifecycle,
  catalogIdentityCode,
  classifySafetyBoundary,
  createAgentEventObserver,
  decisionProvenanceMetadata,
  DECISION_PROVENANCE_SCHEMA_VERSION,
  observeTurnAttempt,
  observeTurnEnqueue,
  projectTurnView,
  pseudonymousUserId,
  scoreQuoteTurnDecision,
  redactTelemetryData,
  resolveTelemetryConfig,
  runtimeMetrics,
  startTelemetry,
  telemetryContent,
  telemetryErrorCode,
} from "../src/telemetry.js";

function emptyDecisionState(version: number) {
  return {
    version,
    contractVersion: "quote-leads-sg-v1",
    target: null,
    pendingTargetConfirmation: null,
    leadSet: null,
    displayQuoteLeadRefs: [],
  };
}

function targetedDecisionState(
  version: number,
  targetRef: string,
  leadOutcome: string | null = "QUOTE_LEADS",
  identity: { modelKey?: string; canonicalModel?: string } = {},
) {
  return {
    version,
    contractVersion: "quote-leads-sg-v1",
    target: {
      targetRef,
      ...(identity.modelKey ? { modelKey: identity.modelKey } : {}),
      ...(identity.canonicalModel ? { canonicalModel: identity.canonicalModel } : {}),
      identity: { outcome: "RESOLVED", strength: "CURATED_ALIAS" },
    },
    pendingTargetConfirmation: null,
    leadSet: leadOutcome ? { outcome: leadOutcome } : null,
    displayQuoteLeadRefs: leadOutcome === "QUOTE_LEADS" ? ["ql_1"] : [],
  };
}

describe("Langfuse telemetry", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires a complete Langfuse credential pair and captures content unless explicitly disabled", () => {
    expect(resolveTelemetryConfig({ LANGFUSE_TRACING_ENVIRONMENT: "Development" })).toMatchObject({
      langfuseEnabled: false,
      environment: "development",
      captureContent: true,
    });
    expect(() => resolveTelemetryConfig({ LANGFUSE_PUBLIC_KEY: "pk-lf-test" })).toThrow(
      "LANGFUSE_CREDENTIALS_INCOMPLETE",
    );
    expect(resolveTelemetryConfig({
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: "https://langfuse.example.test",
      LANGFUSE_TRACING_ENVIRONMENT: "Staging CN",
      RETAIL_PRICE_TELEMETRY_PSEUDONYM_KEY: "test-pseudonym-key-with-at-least-32-bytes",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
    })).toMatchObject({
      langfuseEnabled: true,
      baseUrl: "https://langfuse.example.test",
      environment: "staging-cn",
      captureContent: true,
      metricsEndpoint: "http://collector:4318/v1/metrics",
    });
    expect(resolveTelemetryConfig({
      RETAIL_PRICE_LANGFUSE_CAPTURE_CONTENT: "false",
    })).toMatchObject({ captureContent: false });
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
    expect(telemetryContent({ query: "private query" }, {})).toEqual({ query: "private query" });
    expect(telemetryContent({ query: "private query" }, { RETAIL_PRICE_LANGFUSE_CAPTURE_CONTENT: "false" })).toEqual({
      contentCaptured: false,
    });
    expect(telemetryErrorCode(new Error("provider echoed private query"))).toBe("UNEXPECTED_ERROR");
    expect(telemetryErrorCode(new Error("BUYWHERE_HTTP_429"))).toBe("BUYWHERE_HTTP_429");
    expect(telemetryErrorCode(Object.assign(new Error("opaque domain failure"), { code: "WORKING_SET_REQUIRED" }))).toBe("WORKING_SET_REQUIRED");
  });

  it("classifies bounded domain safety failures without treating provider outages as safety incidents", () => {
    expect(classifySafetyBoundary("CLAIM_EVIDENCE_NOT_ALLOWED")).toEqual({ claimValidation: true, evidence: true, safety: true });
    expect(classifySafetyBoundary("UNNECESSARY_PROVIDER_SEARCH")).toEqual({ claimValidation: false, evidence: false, safety: true });
    expect(classifySafetyBoundary("BUYWHERE_HTTP_503")).toEqual({ claimValidation: false, evidence: false, safety: false });
  });

  it("exports one correlated agent tree without raw content", async () => {
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "test");
    vi.stubEnv("RETAIL_PRICE_LANGFUSE_CAPTURE_CONTENT", "false");
    vi.stubEnv("RETAIL_PRICE_TELEMETRY_PSEUDONYM_KEY", "test-pseudonym-key-with-at-least-32-bytes");
    const exporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter();
    const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
    const telemetry = await startTelemetry(
      "retail-price-telemetry-test",
      {
        LANGFUSE_PUBLIC_KEY: "pk-lf-test-value",
        LANGFUSE_SECRET_KEY: "sk-lf-test-value",
        LANGFUSE_TRACING_ENVIRONMENT: "test",
        RETAIL_PRICE_TELEMETRY_PSEUDONYM_KEY: "test-pseudonym-key-with-at-least-32-bytes",
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
    let enqueueTraceId: string | undefined;
    let enqueueObservationId: string | undefined;
    try {
      await observeTurnEnqueue({
        conversationId: turn.conversationId,
        tenantId: turn.tenantId,
        ownerId: turn.ownerId,
        operation: "accept_turn",
        inputType: "MESSAGE",
      }, async (active) => {
        enqueueTraceId = active.traceId;
        enqueueObservationId = active.rootObservationId;
        return { id: turn.turnId, accepted: true };
      });
      await observeTurnAttempt({
        ...turn,
        ...(enqueueTraceId ? { causedByTraceId: enqueueTraceId } : {}),
        ...(enqueueObservationId ? { causedByObservationId: enqueueObservationId } : {}),
      }, async () => {
        const agentObserver = createAgentEventObserver({
          promptName: "test-prompt",
          promptVersion: "test-v1",
          promptSha256: `sha256:${"a".repeat(64)}`,
        });
        const assistantMessage = {
          role: "assistant" as const,
          content: [{ type: "toolCall" as const, id: "call-1", name: "commit_quote_plan", arguments: {} }],
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
        agentObserver.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "commit_quote_plan", args: {} });
        const toolResult = await agentObserver.observeToolCall({
          toolCallId: "call-1",
          toolName: "commit_quote_plan",
          arguments: {},
          inferenceIndex: 1,
          phase: "PLAN",
        }, async () => {
          const resolution = resolveQuoteTarget({
            rawText: "Sony WH-1000XM5 headphones",
            proposedModel: "WH-1000XM5",
            brand: "Sony",
            productType: "headphones",
          });
          if (resolution.status !== "RESOLVED") throw new Error("telemetry target fixture failed");
          const provider = new BuyWhereMcpQuoteClient("test-key", {
            fetchImpl: (async () => {
              throw Object.assign(new Error("provider timed out"), { name: "TimeoutError" });
            }) as typeof fetch,
            now: () => new Date("2026-09-02T00:00:00.000Z"),
          });
          await observeQuoteLookupHost({
            effectId: "quote-effect:lookup",
            kind: "QUOTE_LOOKUP",
            operationId: "lookup",
            operationKind: "LOOKUP_QUOTES",
            target: resolution.target,
          }, async () => {
            const execution = await new QuoteLookupService(provider).lookup(resolution);
            if (execution.status !== "LOOKUP_COMPLETED") throw new Error("unexpected lookup result");
            return { leadSet: projectPublishedQuoteLeadSet(execution.leadSet), cacheHit: false };
          });
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true }, terminate: true };
        });
        agentObserver.onEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "commit_quote_plan", result: toolResult, isError: false });
        agentObserver.onEvent({ type: "turn_end", message: assistantMessage, toolResults: [] });
        agentObserver.finish();
        return {
          status: "COMPLETED",
          committed: true,
          decision: buildQuoteTurnDecisionProvenance({
            executionStatus: "COMPLETED",
            before: emptyDecisionState(0),
            after: targetedDecisionState(1, "qt_sony", "DEGRADED", {
              modelKey: "WH1000XM5",
              canonicalModel: "WH-1000XM5",
            }),
            route: "quote_lookup",
            outcome: "DEGRADED",
            disclosureCodes: ["PROVIDER_RESULT_NOT_MARKET_ABSENCE"],
            receipts: [{
              kind: "LOOKUP_QUOTES",
              status: "APPLIED",
              providerCalled: true,
              providerInvocation: "LIVE",
              publicResult: {
                outcome: "DEGRADED",
                providerStatus: "DEGRADED",
                providerFailureCode: "BUYWHERE_TIMEOUT",
                providerInvocation: "LIVE",
                quoteLeadCount: 0,
              },
            }],
            planOps: [{ kind: "LOOKUP_QUOTES" }],
            review: { decision: "APPROVED" },
            modelInferences: 1,
            toolCalls: 1,
            usedFallback: false,
            fallbackReasonCode: null,
            attempt: 1,
          }),
        };
      });
      runtimeMetrics.apiEnqueueDuration.record(0.01, { operation: "accept_turn", outcome: "accepted" });
      await telemetry.forceFlush();
      await telemetry.forceFlush();
      const spans = exporter.getFinishedSpans();
      const names = spans.map((span) => span.name);
      expect(names).toEqual(expect.arrayContaining([
        "enqueue-turn",
        "execute-turn-attempt",
        "planner.plan",
        "agent.tool.commit_quote_plan",
        "turn_executor.quote-lookup",
        "tool.provider.buywhere.find_best_price_v2",
        "validate-agent-tool-causality",
      ]));
      expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(2);
      const modelTool = spans.find((span) => span.name === "agent.tool.commit_quote_plan");
      const providerTool = spans.find((span) => span.name === "tool.provider.buywhere.find_best_price_v2");
      const turnExecutorStep = spans.find((span) => span.name === "turn_executor.quote-lookup");
      const generation = spans.find((span) => span.name === "planner.plan");
      const traceRoot = spans.find((span) => span.name === "conversation-turn-enqueue");
      const enqueue = spans.find((span) => span.name === "enqueue-turn");
      const agentRoot = spans.find((span) => span.name === "execute-turn-attempt");
      expect(traceRoot).toBeDefined();
      expect(traceRoot?.parentSpanContext).toBeUndefined();
      expect(enqueue?.parentSpanContext?.spanId).toBe(traceRoot?.spanContext().spanId);
      expect(agentRoot?.parentSpanContext).toBeUndefined();
      expect(agentRoot?.spanContext().traceId).not.toBe(traceRoot?.spanContext().traceId);
      expect(modelTool).toBeDefined();
      expect(turnExecutorStep?.parentSpanContext?.spanId).toBe(modelTool?.spanContext().spanId);
      expect(providerTool?.parentSpanContext?.spanId).toBe(turnExecutorStep?.spanContext().spanId);
      expect(JSON.stringify(providerTool?.attributes)).toContain("BUYWHERE_TIMEOUT");
      expect(JSON.stringify(providerTool?.attributes)).toContain("providerRequestId");
      expect(JSON.stringify(providerTool?.attributes)).toContain("cacheHit");
      expect(JSON.stringify(turnExecutorStep?.attributes)).toContain("LIVE");
      expect(JSON.stringify(modelTool?.attributes)).toContain("call-1");
      expect(JSON.stringify(generation?.attributes)).toContain("PLAN");
      expect(JSON.stringify(generation?.attributes)).toContain("contextSha256");
      expect(JSON.stringify(generation?.attributes)).toContain("toolSchemaSha256");
      expect(JSON.stringify(generation?.attributes)).toContain("tool_calls");
      expect(JSON.stringify(generation?.attributes)).toContain("[CONTENT_NOT_CAPTURED]");
      expect(JSON.stringify(agentRoot?.attributes)).toContain(enqueueTraceId);
      expect(JSON.stringify(agentRoot?.attributes)).toContain("[CONTENT_NOT_CAPTURED]");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("langfuse.observation.input");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("role");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("DEGRADED | quote_lookup");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("decisionAfterModelKey");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("WH1000XM5");
      expect(agentRoot?.links.some((link) => link.context.traceId === enqueueTraceId)).toBe(true);
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
      expect(exported).toContain("quote_lookup");
      expect(exported).toContain("DEGRADED");
      expect(exported).toContain("LOOKUP_QUOTES");
      expect(exported).toContain(DECISION_PROVENANCE_SCHEMA_VERSION);
      expect(JSON.stringify(agentRoot?.attributes)).toContain("decisionRoute");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("decisionOutcome");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("decisionTargetLifecycle");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("decisionProviderInvocation");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("decisionProviderFailureCode");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("BUYWHERE_TIMEOUT");
      expect(JSON.stringify(agentRoot?.attributes)).toContain("ESTABLISHED");
      expect(resourceAttributes).not.toContain("process.command_args");
      expect(resourceAttributes).not.toContain("process.command_line");
      expect(resourceAttributes).toContain("retail-price-telemetry-test");
      const metricNames = metricExporter.getMetrics().flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)));
      expect(metricNames).toContain("retail_price_agent.api.enqueue.duration");
      expect(metricNames).toContain("retail_price_agent.provider.request.duration");
      expect(metricNames).toContain("retail_price_agent.provider.errors");
      expect(metricNames).toContain("retail_price_agent.telemetry.export_lifecycle");
      expect(metricNames).toContain("retail_price_agent.trace.causality_checks");
    } finally {
      await telemetry.shutdown();
    }
  });
});

describe("turn decision provenance", () => {
  it("maps a decline of a new accessory as SUPERSEDE and CLEARED", () => {
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: targetedDecisionState(3, "qt_sony"),
      after: emptyDecisionState(4),
      route: "talk",
      outcome: "CHAT",
      disclosureCodes: [],
      receipts: [{
        kind: "DECLINE_UNSUPPORTED_QUOTE_TARGET",
        status: "APPLIED",
        providerCalled: false,
        publicResult: { declinedReasonCode: "ACCESSORY_OR_PART", targetRetained: false },
      }],
      planOps: [{ kind: "DECLINE_UNSUPPORTED_QUOTE_TARGET", reasonCode: "ACCESSORY_OR_PART" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 2,
    });
    expect(decision).toMatchObject({
      schemaVersion: DECISION_PROVENANCE_SCHEMA_VERSION,
      targetLifecycle: "CLEARED",
      targetDisposition: "SUPERSEDE",
      before: { hasTarget: true, leadOutcome: "QUOTE_LEADS" },
      after: { hasTarget: false, leadOutcome: null },
      operations: [{ kind: "DECLINE_UNSUPPORTED_QUOTE_TARGET", reasonCode: "ACCESSORY_OR_PART" }],
    });
    expect(assertDecisionProvenanceNonPii(decision)).toBe(decision);
  });

  it("retains an active target when the declined accessory belongs to it", () => {
    const active = targetedDecisionState(3, "qt_sony");
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: active,
      after: active,
      route: "talk",
      outcome: "CHAT",
      disclosureCodes: [],
      receipts: [{
        kind: "DECLINE_UNSUPPORTED_QUOTE_TARGET",
        status: "APPLIED",
        providerCalled: false,
        publicResult: { declinedReasonCode: "ACCESSORY_OR_PART", targetRetained: true },
      }],
      planOps: [{ kind: "DECLINE_UNSUPPORTED_QUOTE_TARGET", reasonCode: "ACCESSORY_OR_PART", targetDisposition: "RETAIN" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 1,
    });
    expect(decision).toMatchObject({
      targetLifecycle: "RETAINED",
      targetDisposition: "RETAIN",
      after: { hasTarget: true, identityStrength: "CURATED_ALIAS" },
    });
  });

  it("keeps applied provider evidence on attempt replay without counting a live HTTP call", () => {
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: emptyDecisionState(0),
      after: targetedDecisionState(1, "qt_sony", "DEGRADED"),
      route: "quote_lookup",
      outcome: "DEGRADED",
      disclosureCodes: ["PROVIDER_RESULT_NOT_MARKET_ABSENCE"],
      receipts: [{
        kind: "LOOKUP_QUOTES",
        status: "APPLIED",
        providerInvocation: "ATTEMPT_REPLAY",
        providerCalled: false,
        publicResult: {
          outcome: "DEGRADED",
          providerStatus: "DEGRADED",
          providerFailureCode: "BUYWHERE_TIMEOUT",
          providerInvocation: "ATTEMPT_REPLAY",
          quoteLeadCount: 0,
        },
      }],
      planOps: [{ kind: "LOOKUP_QUOTES" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 1,
    });
    expect(decision.provider).toMatchObject({
      providerInvocation: "ATTEMPT_REPLAY",
      providerFailureCode: "BUYWHERE_TIMEOUT",
    });
    expect(decision.operations).toEqual([expect.objectContaining({
      kind: "LOOKUP_QUOTES",
      providerInvocation: "ATTEMPT_REPLAY",
      providerCalled: false,
    })]);
    expect(decisionProvenanceMetadata(decision).decisionProviderInvocation).toBe("ATTEMPT_REPLAY");
    expect(decisionProvenanceMetadata(decision).decisionProviderFailureCode).toBe("BUYWHERE_TIMEOUT");
  });

  it("records review violations and a failed execution without inventing an after-state", () => {
    const before = emptyDecisionState(0);
    const decision = assembleQuoteTurnDecision({
      executionStatus: "FAILED",
      before,
      review: { decision: "REPAIR_REQUIRED", violations: [{ code: "QUOTE_PRIMARY_PRODUCT_REQUIRED" }] },
      planOps: [{ kind: "SET_QUOTE_TARGET" }],
      fallbackReasonCode: "QUOTE_PRIMARY_PRODUCT_REQUIRED",
      attempt: 1,
    });
    expect(decision).toMatchObject({
      executionStatus: "FAILED",
      outcome: "NONE",
      reviewDecision: "REPAIR_REQUIRED",
      reviewViolationCodes: ["QUOTE_PRIMARY_PRODUCT_REQUIRED"],
      targetLifecycle: "UNCHANGED",
      before: { hasTarget: false },
      after: { hasTarget: false },
    });
  });

  it("derives ESTABLISHED / PENDING / REPLACED from target refs only", () => {
    expect(deriveTargetLifecycle(emptyDecisionState(0), targetedDecisionState(1, "qt_a"))).toBe("ESTABLISHED");
    expect(deriveTargetLifecycle(emptyDecisionState(0), { ...emptyDecisionState(1), pendingTargetConfirmation: {} })).toBe("PENDING");
    expect(deriveTargetLifecycle(targetedDecisionState(1, "qt_a"), targetedDecisionState(2, "qt_b"))).toBe("REPLACED");
  });

  it("records catalog identity on replace without accepting user utterances", () => {
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: targetedDecisionState(1, "qt_sony", "QUOTE_LEADS", { modelKey: "WH1000XM5", canonicalModel: "WH-1000XM5" }),
      after: targetedDecisionState(2, "qt_beats", "QUOTE_LEADS", { modelKey: "STUDIOPRO", canonicalModel: "Studio Pro" }),
      route: "quote_lookup",
      outcome: "QUOTE_LEADS",
      disclosureCodes: [],
      receipts: [],
      planOps: [{ kind: "SET_QUOTE_TARGET" }, { kind: "LOOKUP_QUOTES" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 1,
    });
    expect(decision.targetLifecycle).toBe("REPLACED");
    expect(decision.before).toMatchObject({ targetRef: "qt_sony", modelKey: "WH1000XM5", canonicalModel: "WH-1000XM5" });
    expect(decision.after).toMatchObject({ targetRef: "qt_beats", modelKey: "STUDIOPRO", canonicalModel: "Studio_Pro" });
    expect(decisionProvenanceMetadata(decision)).toMatchObject({
      decisionBeforeModelKey: "WH1000XM5",
      decisionAfterModelKey: "STUDIOPRO",
      decisionAfterCanonicalModel: "Studio_Pro",
    });
    expect(() => assertDecisionProvenanceNonPii({
      ...decision,
      after: { ...decision.after, canonicalModel: "Sony WH-1000XM5 headphones" },
    })).toThrow(/DECISION_PROVENANCE_PII_DETECTED/);
  });

  it("rejects free text so the decision channel cannot drift into content", () => {
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: emptyDecisionState(0),
      after: emptyDecisionState(1),
      route: "clarify",
      outcome: "CLARIFICATION",
      disclosureCodes: [],
      receipts: [{ kind: "REQUEST_QUOTE_MODEL_CONFIRMATION", status: "APPLIED", providerCalled: false, publicResult: {} }],
      planOps: [{ kind: "REQUEST_QUOTE_MODEL_CONFIRMATION" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 1,
    });
    expect(() => assertDecisionProvenanceNonPii({
      ...decision,
      outcome: "please give the exact model",
    })).toThrow(/DECISION_PROVENANCE_PII_DETECTED/);
    expect(() => assertDecisionProvenanceNonPii({
      ...decision,
      fallbackReasonCode: "buyer@example.com",
    })).toThrow(/DECISION_PROVENANCE_PII_DETECTED/);
  });
});

describe("turn view projection", () => {
  it("keeps a scannable OpenAI message pair when content is off", () => {
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: emptyDecisionState(0),
      after: targetedDecisionState(1, "qt_sony", "QUOTE_LEADS", { modelKey: "WH1000XM5", canonicalModel: "WH-1000XM5" }),
      route: "quote_lookup",
      outcome: "QUOTE_LEADS",
      disclosureCodes: [],
      receipts: [],
      planOps: [{ kind: "SET_QUOTE_TARGET" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 1,
    });
    const view = projectTurnView({
      userMessages: ["查 Sony WH-1000XM5 报价"],
      replyText: "商家页有两条报价",
      status: "COMPLETED",
      decision,
      environment: { RETAIL_PRICE_LANGFUSE_CAPTURE_CONTENT: "false" },
    });
    expect(view.input).toEqual([{ role: "user", content: "[CONTENT_NOT_CAPTURED]" }]);
    expect(view.output).toEqual([{ role: "assistant", content: "QUOTE_LEADS | quote_lookup | ESTABLISHED | WH-1000XM5" }]);
    expect(JSON.stringify(view)).not.toContain("Sony");
  });

  it("scores catalog identity against the same decision mapper", () => {
    const decision = buildQuoteTurnDecisionProvenance({
      executionStatus: "COMPLETED",
      before: targetedDecisionState(1, "qt_sony", "QUOTE_LEADS", { modelKey: "WH1000XM5" }),
      after: targetedDecisionState(2, "qt_beats", "QUOTE_LEADS", { modelKey: "STUDIOPRO", canonicalModel: "Studio Pro" }),
      route: "quote_lookup",
      outcome: "QUOTE_LEADS",
      disclosureCodes: [],
      receipts: [],
      planOps: [{ kind: "SET_QUOTE_TARGET", targetDisposition: "SUPERSEDE" }, { kind: "LOOKUP_QUOTES" }],
      review: { decision: "APPROVED" },
      modelInferences: 1,
      toolCalls: 1,
      usedFallback: false,
      fallbackReasonCode: null,
      attempt: 1,
    });
    expect(scoreQuoteTurnDecision(decision, {
      route: "quote_lookup",
      outcome: "QUOTE_LEADS",
      hasTarget: true,
      targetLifecycle: "REPLACED",
      modelKey: "STUDIOPRO",
      canonicalModel: "Studio Pro",
    })).toEqual([
      { name: "route", value: 1 },
      { name: "outcome", value: 1 },
      { name: "hasTarget", value: 1 },
      { name: "targetLifecycle", value: 1 },
      { name: "modelKey", value: 1 },
      { name: "canonicalModel", value: 1 },
    ]);
    expect(catalogIdentityCode("Galaxy S24 Ultra")).toBe("Galaxy_S24_Ultra");
    expect(catalogIdentityCode("帮我看看索尼")).toBeNull();
  });
});
