import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(resolve(root, "spec/observability/metrics-contract.json"), "utf8"));
const operationsPolicy = JSON.parse(await readFile(resolve(root, "spec/observability/operations-acceptance-policy.json"), "utf8"));
const agentTraceContract = JSON.parse(await readFile(resolve(root, "spec/observability/agent-trace-contract.json"), "utf8"));
const telemetry = (await Promise.all([
  "telemetry.ts",
  "runtime-metrics.ts",
  "telemetry-safety.ts",
  "agent-telemetry.ts",
].map((file) => readFile(resolve(root, "packages/runtime/src", file), "utf8")))).join("\n");
const agentProtocol = await readFile(resolve(root, "packages/agent/src/protocol.ts"), "utf8");
const agentRuntime = await readFile(resolve(root, "packages/agent/src/turn-agent.ts"), "utf8");
const repositoryTurnSession = await readFile(resolve(root, "packages/runtime/src/repository-turn-session.ts"), "utf8");
const runtimePackage = JSON.parse(await readFile(resolve(root, "packages/runtime/package.json"), "utf8"));
const promptIntegration = await readFile(resolve(root, "packages/runtime/src/langfuse-prompt.ts"), "utf8");
const experimentPublisher = await readFile(resolve(root, "scripts/publish_langfuse_development_evaluation.ts"), "utf8");
const ingestionChecker = await readFile(resolve(root, "scripts/check_langfuse_ingestion.ts"), "utf8");
const alertsText = await readFile(resolve(root, "ops/prometheus/conversation-alerts.yml"), "utf8");
const alertsDocument = parseDocument(alertsText);
if (alertsDocument.errors.length) throw new Error(`OBSERVABILITY_ALERTS_YAML_INVALID:${alertsDocument.errors[0].message}`);
const dashboard = JSON.parse(await readFile(resolve(root, "ops/grafana/conversation-runtime-dashboard.json"), "utf8"));

async function readTypeScriptTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return readTypeScriptTree(path);
    return entry.name.endsWith(".ts") ? readFile(path, "utf8") : "";
  }))).flat(Infinity).join("\n");
}

const activeSource = await readTypeScriptTree(resolve(root, "packages"));

if (runtimePackage.dependencies?.["@langfuse/client"] !== "5.10.1") throw new Error("OBSERVABILITY_LANGFUSE_CLIENT_NOT_EXACTLY_PINNED");
if (!telemetry.includes("prompt: options.promptLink")) throw new Error("OBSERVABILITY_NATIVE_PROMPT_LINK_MISSING");
if (!promptIntegration.includes("LANGFUSE_PROMPT_CONTENT_DRIFT") || !promptIntegration.includes("sourceSha256")) {
  throw new Error("OBSERVABILITY_PROMPT_DRIFT_GUARD_MISSING");
}
if (!experimentPublisher.includes("executor.execute(testCase, runIndex,") || experimentPublisher.includes("projection: true")) {
  throw new Error("OBSERVABILITY_REAL_EXPERIMENT_EXECUTOR_MISSING");
}
if (!ingestionChecker.includes("scoresV3.getManyV3") || ingestionChecker.includes("api.scores.getMany")) {
  throw new Error("OBSERVABILITY_SCORES_V3_CONTRACT_MISSING");
}
if (!ingestionChecker.includes("core,basic,io,metadata")
  || !ingestionChecker.includes("serializedRecord(observation[\"output\"])")
  || !ingestionChecker.includes("modelToolsWithCausality")) {
  throw new Error("OBSERVABILITY_TOOL_IO_SERVER_VERIFICATION_MISSING");
}
if (agentTraceContract.schemaVersion !== "interec-agent-trace-v2"
  || agentTraceContract.modelBoundary?.sourceOfTruth !== "STREAM_FN_PROVIDER_BOUNDARY") {
  throw new Error("OBSERVABILITY_AGENT_TRACE_CONTRACT_INVALID");
}
for (const token of ["tool_execution_start", "tool_execution_end", "contextSha256", "toolSchemaSha256", "modelVisibleResult", "agent.tool."]) {
  if (!telemetry.includes(token)) throw new Error(`OBSERVABILITY_AGENT_TRACE_IMPLEMENTATION_MISSING:${token}`);
}
for (const generationName of Object.values(agentTraceContract.generationNames ?? {})) {
  if (!telemetry.includes(generationName)) throw new Error(`OBSERVABILITY_AGENT_GENERATION_PHASE_MISSING:${generationName}`);
}
if (agentProtocol.includes("execute: async (_toolCallId") || !agentProtocol.includes("observeToolCall")) {
  throw new Error("OBSERVABILITY_TOOL_CALL_ID_PROPAGATION_MISSING");
}
if (!agentRuntime.includes("onModelCall?.({ model, context") || !repositoryTurnSession.includes("observeTurnExecutorStep")) {
  throw new Error("OBSERVABILITY_PROVIDER_CONTEXT_OR_HOST_HIERARCHY_MISSING");
}
for (const token of ["datasetItemId", "experimentWrapperTraceId", "getActiveTraceId"]) {
  if (!experimentPublisher.includes(token)) throw new Error(`OBSERVABILITY_EXPERIMENT_TRACE_LINK_MISSING:${token}`);
}

const metrics = contract.metrics ?? [];
if (!Array.isArray(metrics) || metrics.length < 10) throw new Error("OBSERVABILITY_METRICS_CONTRACT_INCOMPLETE");
const names = new Set();
for (const metric of metrics) {
  if (!metric.name || names.has(metric.name)) throw new Error(`OBSERVABILITY_METRIC_DUPLICATE:${metric.name}`);
  names.add(metric.name);
  const declaration = new RegExp(`(\\w+):\\s*meter\\.create\\w+\\(\\"${metric.name.replaceAll(".", "\\.")}\\"`).exec(telemetry);
  if (!declaration) throw new Error(`OBSERVABILITY_METRIC_NOT_DECLARED:${metric.name}`);
  if (!activeSource.includes(`runtimeMetrics.${declaration[1]}`)) throw new Error(`OBSERVABILITY_METRIC_NOT_RECORDED:${metric.name}`);
  const forbidden = new Set(contract.forbiddenLabels ?? []);
  for (const label of metric.labels ?? []) if (forbidden.has(label)) throw new Error(`OBSERVABILITY_HIGH_CARDINALITY_LABEL:${metric.name}:${label}`);
}

const dashboardText = JSON.stringify(dashboard);
for (const sourceName of [
  "rec_agent.api.enqueue.duration",
  "rec_agent.api.projection.duration",
  "rec_agent.sse.lag.duration",
  "rec_agent.queue.wait.duration",
  "rec_agent.turn.duration",
  "rec_agent.turn.terminal",
  "rec_agent.plan_review.decisions",
  "rec_agent.goal.retention_checks",
  "rec_agent.clarification.resolutions",
  "rec_agent.semantic_relevance.attempts",
]) {
  const prometheusName = sourceName.replaceAll(".", "_");
  if (!dashboardText.includes(prometheusName)) throw new Error(`OBSERVABILITY_DASHBOARD_METRIC_MISSING:${sourceName}`);
}

const alerts = alertsDocument.toJS()?.groups?.flatMap((group) => group.rules ?? []) ?? [];
const alertNames = new Set(alerts.map((alert) => alert.alert));
for (const required of operationsPolicy.requiredAlertNames ?? []) {
  if (!alertNames.has(required)) throw new Error(`OBSERVABILITY_ALERT_MISSING:${required}`);
}
const panelIds = new Set((dashboard.panels ?? []).map((panel) => panel.id));
for (const required of operationsPolicy.requiredDashboardPanelIds ?? []) {
  if (!panelIds.has(required)) throw new Error(`OBSERVABILITY_DASHBOARD_PANEL_MISSING:${required}`);
}

process.stdout.write(`observability contract: ${metrics.length} metrics, ${dashboard.panels.length} panels, ${alerts.length} alerts, agent trace ${agentTraceContract.schemaVersion}, executable target-evidence policy\n`);
