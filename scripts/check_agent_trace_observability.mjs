import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function textFile(path) {
  return readFile(new URL(path, root), "utf8");
}

const [
  contractText,
  turnObservability,
  agentTelemetry,
  traceRendering,
  traceModel,
  lifecycle,
  migration,
  enqueueMigration,
  traceTests,
  packageText,
  runtimeMetrics,
  metricsContractText,
  conversationRoutes,
  buyWhereClient,
  buyWhereObservation,
  quoteLookupHostObservation,
  quoteTurnDataService,
  quoteEffects,
  quoteDecision,
  decisionTypes,
  telemetryTests,
  identityMigration,
  turnSubmission,
  attemptStore,
  telemetryRuntime,
  apiMain,
  workerMain,
] = await Promise.all([
  textFile("spec/observability/agent-trace-contract.json"),
  textFile("packages/runtime/src/turn-observability.ts"),
  textFile("packages/runtime/src/agent-telemetry.ts"),
  textFile("packages/runtime/src/agent-trace-rendering.ts"),
  textFile("packages/runtime/src/agent-trace-model.ts"),
  textFile("packages/runtime/src/postgres-turn-lifecycle.ts"),
  textFile("packages/runtime/conversation-migrations/0023_attempt_trace_boundary.sql"),
  textFile("packages/runtime/conversation-migrations/0024_enqueue_trace_truthfulness.sql"),
  textFile("packages/runtime/test/agent-trace-model.test.ts"),
  textFile("package.json"),
  textFile("packages/runtime/src/runtime-metrics.ts"),
  textFile("spec/observability/metrics-contract.json"),
  textFile("packages/api/src/conversation-routes.ts"),
  textFile("packages/runtime/src/buywhere-mcp-quote-client.ts"),
  textFile("packages/runtime/src/buywhere-provider-observability.ts"),
  textFile("packages/runtime/src/quote-lookup-observability.ts"),
  textFile("packages/runtime/src/quote-turn-data-service.ts"),
  textFile("packages/domain/src/quote-effects.ts"),
  textFile("packages/runtime/src/quote-turn-decision-provenance.ts"),
  textFile("packages/runtime/src/turn-decision-provenance.ts"),
  textFile("packages/runtime/test/telemetry.test.ts"),
  textFile("packages/runtime/conversation-migrations/0025_trace_identity_provenance.sql"),
  textFile("packages/runtime/src/postgres-turn-submission.ts"),
  textFile("packages/runtime/src/postgres-turn-attempt-store.ts"),
  textFile("packages/runtime/src/telemetry-runtime.ts"),
  textFile("packages/api/src/conversation-api-main.ts"),
  textFile("packages/runtime/src/conversation-worker-main.ts"),
]);
const telemetrySafety = await textFile("packages/runtime/src/telemetry-safety.ts");

const contract = JSON.parse(contractText);
const packageJson = JSON.parse(packageText);
const metricsContract = JSON.parse(metricsContractText);
const failures = [];
const requireCondition = (condition, message) => {
  if (!condition) failures.push(message);
};
const requireText = (source, token, location) => {
  requireCondition(source.includes(token), `${location} is missing ${JSON.stringify(token)}`);
};

requireCondition(contract.schemaVersion === "interec-agent-trace-v4", "trace contract must use v4");
requireCondition(contract.traceBoundary === "TURN_ATTEMPT", "trace boundary must be TURN_ATTEMPT");
requireCondition(contract.enqueueTrace?.separateFromAttempt === true, "enqueue and attempt traces must be separate");
requireCondition(contract.enqueueTrace?.mustBeActualRoot === true, "enqueue must be an actual root");
requireCondition(contract.enqueueTrace?.nullableUntilActualRootExists === true, "missing enqueue observations must not get synthetic trace ids");
requireCondition(contract.attemptIdentity?.traceId === "ACTUAL_ROOT_TRACE_ID", "attempt must persist the actual root trace id");
requireCondition(contract.toolCausality?.requireNextGenerationResultReference === true, "tool result consumption must be required");
requireCondition(contract.modelBoundary?.canonicalization === "RECURSIVE_KEY_SORT_EXCLUDE_LOCAL_RUNTIME_FIELDS", "model manifest canonicalization is not frozen");
requireCondition(contract.modelBoundary?.digest === "HMAC_SHA256_WHEN_TELEMETRY_KEY_AVAILABLE", "model manifest must use keyed production digests");
requireCondition(contract.hierarchy?.providerExecutionType === "TOOL", "provider execution must remain a TOOL");
requireCondition(contract.hierarchy?.buyWhereProviderObservation === "tool.provider.buywhere.find_best_price_v2", "production BuyWhere observation name drifted");
requireCondition(contract.exportReliability?.workerCheckpoint === "FORCE_FLUSH_AFTER_COMPLETED_TURN", "worker export checkpoint is not frozen");
requireCondition(contract.exportReliability?.shutdownStrict === true, "shutdown export failures must be surfaced");
requireCondition(contract.decisionProvenance?.schemaVersion === "interec-turn-decision-v5", "decision provenance schema must version catalog identity");
requireCondition(contract.viewProjection?.inputFormat === "OPENAI_COMPATIBLE_CHAT_MESSAGES", "root I/O must stay OpenAI messages");
requireCondition(contract.viewProjection?.contentOffAssistant === "DECISION_SCAN_LINE", "content-off assistant I/O must stay a decision scan line");
requireCondition(contract.decisionProvenance?.stateSnapshotFields?.includes("modelKey"), "decision snapshot must carry catalog modelKey");
requireCondition(contract.decisionProvenance?.filterMetadata?.includes("decisionAfterModelKey"), "decision metadata must expose after modelKey");
requireCondition(contract.privacy?.contentDefault === "ENABLED", "content capture must default on");
requireText(telemetrySafety, 'flag !== "false"', "telemetry-safety.ts");
requireCondition(!telemetrySafety.includes("INTEREC_LANGFUSE_CAPTURE_CONSENT_REQUIRED"), "content capture must not require a second consent latch");

requireText(turnObservability, "traceName: \"conversation-turn-enqueue\"", "turn-observability.ts");
requireText(turnObservability, "traceName: \"conversation-turn-attempt\"", "turn-observability.ts");
requireText(turnObservability, "\"turn-enqueue\"", "turn-observability.ts");
requireText(turnObservability, "\"turn-attempt\"", "turn-observability.ts");
requireText(turnObservability, "causedByTraceId", "turn-observability.ts");
requireText(turnObservability, "addLink", "turn-observability.ts");
requireText(turnObservability, "projectTurnView", "turn-observability.ts");
requireText(decisionTypes, "catalogIdentityCode", "turn-decision-provenance.ts");
requireText(decisionTypes, "decisionAfterModelKey", "turn-decision-provenance.ts");
requireText(quoteDecision, "canonicalModel: catalogIdentityCode", "quote-turn-decision-provenance.ts");
requireCondition(!turnObservability.includes("parentSpanContext"), "turn observations must not construct cross-process parent spans");
requireCondition(!turnObservability.includes("parentSpanIdForTrace"), "turn observations must not synthesize parent span ids");
requireCondition(!turnObservability.includes("fallbackTraceId"), "enqueue observations must not mint ghost trace ids");
requireCondition(!conversationRoutes.includes("telemetryTraceIdForTurn"), "API routes must not persist deterministic trace ids");
requireCondition(
  conversationRoutes.match(/telemetryTraceId: active\.traceId/gu)?.length === 2,
  "accept and retry routes must persist the actual active enqueue trace id",
);

requireText(buyWhereClient, "observeBuyWhereProviderCall", "buywhere-mcp-quote-client.ts");
requireText(buyWhereObservation, '"tool.provider.buywhere.find_best_price_v2"', "buywhere-provider-observability.ts");
requireText(buyWhereObservation, '{ asType: "tool" }', "buywhere-provider-observability.ts");
for (const field of contract.hierarchy.providerResultFields) {
  requireText(buyWhereObservation, field, "buywhere-provider-observability.ts");
}
requireText(quoteTurnDataService, "observeQuoteLookupHost", "quote-turn-data-service.ts");
requireText(quoteLookupHostObservation, '"quote-lookup"', "quote-lookup-observability.ts");
requireText(quoteLookupHostObservation, "cacheHit", "quote-lookup-observability.ts");
for (const field of contract.hierarchy.hostResultFields ?? []) {
  requireText(quoteLookupHostObservation, field, "quote-lookup-observability.ts");
}
requireCondition(!telemetryTests.includes('"discover_offers"'), "telemetry tests must not simulate the retired discover_offers provider");
requireCondition(!telemetryTests.includes('"buywhere.search"'), "telemetry tests must not simulate a fake buywhere.search span");
requireCondition(!telemetryTests.includes("commit_turn_plan"), "telemetry tests must use the production commit_quote_plan tool name");
requireText(telemetryTests, "commit_quote_plan", "telemetry.test.ts");
requireText(telemetryTests, "ATTEMPT_REPLAY", "telemetry.test.ts");
requireText(telemetryTests, "providerRequestId", "telemetry.test.ts");
requireText(telemetryTests, "new BuyWhereMcpQuoteClient", "telemetry.test.ts");
requireText(telemetryTests, "BUYWHERE_TIMEOUT", "telemetry.test.ts");

requireText(quoteEffects, "providerFailureCode: leadSet.providerFailureCode", "quote-effects.ts");
requireText(quoteEffects, "QuoteProviderInvocation", "quote-effects.ts");
requireText(quoteEffects, "ATTEMPT_REPLAY", "quote-effects.ts");
requireText(quoteEffects, "providerInvocation: result.providerInvocation", "quote-effects.ts");
requireText(quoteDecision, "providerFailureCode", "quote-turn-decision-provenance.ts");
requireText(quoteDecision, "appliedProviderObservation", "quote-turn-decision-provenance.ts");
requireText(decisionTypes, "decisionProviderFailureCode", "turn-decision-provenance.ts");
requireText(decisionTypes, "decisionProviderInvocation", "turn-decision-provenance.ts");
requireCondition(contract.decisionProvenance?.providerRecordFields?.includes("providerFailureCode"), "decision provider receipt must require providerFailureCode");
requireCondition(contract.decisionProvenance?.providerRecordFields?.includes("providerInvocation"), "decision provider receipt must require providerInvocation");
requireCondition(contract.hierarchy?.providerResultFields?.includes("providerRequestId"), "provider span must carry the outbound request id");
requireText(buyWhereObservation, "providerRequestId", "buywhere-provider-observability.ts");
requireText(buyWhereClient, "const requestId = this.requestId()", "buywhere-mcp-quote-client.ts");
requireText(quoteLookupHostObservation, "ATTEMPT_REPLAY", "quote-lookup-observability.ts");
requireText(quoteTurnDataService, 'providerInvocation: result.cacheHit ? "ATTEMPT_REPLAY" : "LIVE"', "quote-turn-data-service.ts");

requireText(agentTelemetry, "AgentCausalityLedger", "agent-telemetry.ts");
requireText(traceRendering, "tool_calls", "agent-trace-rendering.ts");
requireText(traceRendering, "tool_call_id", "agent-trace-rendering.ts");
requireText(agentTelemetry, "modelVisibleResultSha256", "agent-telemetry.ts");
requireText(agentTelemetry, "traceCausalityChecks.add", "agent-telemetry.ts");
requireText(agentTelemetry, "traceCausalityViolations.add", "agent-telemetry.ts");
for (const field of contract.toolCausality.failureFields) {
  requireText(agentTelemetry, field, "agent-telemetry.ts");
}

requireText(traceModel, "canonicalTraceJson", "agent-trace-model.ts");
requireText(traceModel, "consumption.inferenceIndex >", "agent-trace-model.ts");
requireText(traceModel, "consumption.resultSha256 ===", "agent-trace-model.ts");
requireText(lifecycle, "INSERT INTO interec_agent.turn_attempts (turn_id, attempt, fence_token, base_revision, status)", "postgres-turn-lifecycle.ts");
requireCondition(!lifecycle.includes("turn[\"trace_id\"]],\n    );"), "claim must not copy enqueue trace id into an attempt");
requireText(migration, "ALTER COLUMN trace_id DROP NOT NULL", "0023_attempt_trace_boundary.sql");
requireText(enqueueMigration, "ALTER TABLE interec_agent.turns", "0024_enqueue_trace_truthfulness.sql");
requireText(enqueueMigration, "ALTER COLUMN trace_id DROP NOT NULL", "0024_enqueue_trace_truthfulness.sql");
requireText(identityMigration, "md5(", "0025_trace_identity_provenance.sql");
requireText(identityMigration, "OBSERVED_ENQUEUE_ROOT", "0025_trace_identity_provenance.sql");
requireText(identityMigration, "OBSERVED_ATTEMPT_ROOT", "0025_trace_identity_provenance.sql");
requireText(identityMigration, "turns_trace_identity_provenance_check", "0025_trace_identity_provenance.sql");
requireText(turnSubmission, 'metadata.traceId ? "OBSERVED_ENQUEUE_ROOT" : null', "postgres-turn-submission.ts");
requireText(attemptStore, "trace_id_source = 'OBSERVED_ATTEMPT_ROOT'", "postgres-turn-attempt-store.ts");
requireText(lifecycle, 'turn["trace_id_source"] === "OBSERVED_ENQUEUE_ROOT"', "postgres-turn-lifecycle.ts");

requireText(workerMain, "await telemetry.forceFlush({ strict: false })", "conversation-worker-main.ts");
requireText(workerMain, "TELEMETRY_FORCE_FLUSH_FAILED", "conversation-worker-main.ts");
requireText(workerMain, "await telemetry.shutdown({ strict: true })", "conversation-worker-main.ts");
requireText(apiMain, "await waitForTerminationSignal()", "conversation-api-main.ts");
requireText(apiMain, "await telemetry.shutdown({ strict: true })", "conversation-api-main.ts");
requireCondition(!apiMain.includes("void shutdown()"), "API shutdown must be owned by top-level await");
requireText(telemetryRuntime, "telemetryExportLifecycle", "telemetry-runtime.ts");

requireText(traceTests, "never reaches a later model context", "agent-trace-model.test.ts");
requireText(traceTests, "result substitution", "agent-trace-model.test.ts");
requireText(traceTests, "object key order", "agent-trace-model.test.ts");
requireText(traceTests, "uses a keyed digest", "agent-trace-model.test.ts");
requireCondition(packageJson.scripts?.["observability:check"] === "node scripts/check_agent_trace_observability.mjs", "package.json observability:check is missing or drifted");
requireCondition(typeof packageJson.scripts?.["observability:smoke"] === "string", "package.json observability:smoke is missing");
requireText(await textFile("scripts/observability_smoke.ts"), "INTEREC_LANGFUSE_SMOKE_CONFIRM", "observability_smoke.ts");
requireText(await textFile("scripts/observability_smoke.ts"), "/api/public/traces/", "observability_smoke.ts");
requireText(await textFile("packages/runtime/src/quote-turn-decision-score.ts"), "scoreQuoteTurnDecision", "quote-turn-decision-score.ts");

for (const metricName of [
  "rec_agent.trace.causality_checks",
  "rec_agent.trace.causality_violations",
  "rec_agent.telemetry.export_lifecycle",
]) {
  requireCondition(metricsContract.metrics.some((metric) => metric.name === metricName), `metrics contract is missing ${metricName}`);
  requireText(runtimeMetrics, metricName, "runtime-metrics.ts");
}

if (failures.length > 0) {
  console.error("Agent trace observability contract failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log("Agent trace observability contract passed: boundary, causality, manifest, migration, and adversarial tests are wired.");
}
