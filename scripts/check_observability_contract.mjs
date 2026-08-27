import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(resolve(root, "spec/observability/metrics-contract.json"), "utf8"));
const operationsPolicy = JSON.parse(await readFile(resolve(root, "spec/observability/operations-acceptance-policy.json"), "utf8"));
const telemetry = await readFile(resolve(root, "packages/runtime/src/telemetry.ts"), "utf8");
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

process.stdout.write(`observability contract: ${metrics.length} metrics, ${dashboard.panels.length} panels, ${alerts.length} alerts, executable target-evidence policy\n`);
