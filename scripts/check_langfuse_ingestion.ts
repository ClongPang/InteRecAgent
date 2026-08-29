import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import { resolveTelemetryConfig } from "../packages/runtime/src/index.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`LANGFUSE_INGESTION_INVALID:${label}`);
  return value as JsonRecord;
}

function serializedRecord(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function artifactTraceIds(path: string): string[] {
  const artifact = record(JSON.parse(readFileSync(path, "utf8")), "artifact");
  const trials = Array.isArray(artifact["trials"]) ? artifact["trials"] : [];
  if (process.env["INTEREC_LANGFUSE_INGESTION_SAMPLE_PER_RUN"] === "1") {
    const sampled = new Map<number, string>();
    for (const trialValue of trials) {
      const trial = record(trialValue, "trial");
      const runIndex = Number(trial["runIndex"]);
      if (!Number.isSafeInteger(runIndex) || sampled.has(runIndex) || trial["status"] !== "COMPLETED") continue;
      const evidence = Array.isArray(trial["turnEvidence"]) ? trial["turnEvidence"] : [];
      const traceId = evidence.map((turn) => String(record(turn, "turnEvidence")["trace_id"] ?? ""))
        .filter((value) => /^[0-9a-f]{32}$/.test(value)).at(-1);
      if (traceId) sampled.set(runIndex, traceId);
    }
    return [...sampled.entries()].sort(([left], [right]) => left - right).map(([, traceId]) => traceId);
  }
  return trials.flatMap((trialValue) => {
    const trial = record(trialValue, "trial");
    const evidence = Array.isArray(trial["turnEvidence"]) ? trial["turnEvidence"] : [];
    return evidence.map((turn) => String(record(turn, "turnEvidence")["trace_id"] ?? ""));
  }).filter((traceId) => /^[0-9a-f]{32}$/.test(traceId));
}

const explicitTraceId = process.env["INTEREC_LANGFUSE_TRACE_ID"]?.trim();
const artifactPath = resolve(process.env["INTEREC_LANGFUSE_INGESTION_ARTIFACT"] ?? ".artifacts/evaluation/langfuse-acceptance-qualification-run.json");
const traceIds = explicitTraceId ? [explicitTraceId] : artifactTraceIds(artifactPath);
if (traceIds.length === 0 || traceIds.some((traceId) => !/^[0-9a-f]{32}$/.test(traceId))) throw new Error("LANGFUSE_INGESTION_TRACE_ID_REQUIRED");

const telemetryConfig = resolveTelemetryConfig();
if (!telemetryConfig.langfuseEnabled) throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
const langfuse = new LangfuseClient({
  publicKey: telemetryConfig.publicKey!,
  secretKey: telemetryConfig.secretKey!,
  ...(telemetryConfig.baseUrl ? { baseUrl: telemetryConfig.baseUrl } : {}),
  timeout: 5,
});
const wait = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
try {
  const results: Array<Record<string, unknown>> = [];
  for (const traceId of traceIds) {
    let observations: Array<JsonRecord> = [];
    let traceDetails: JsonRecord = {};
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const [response, traceResponse] = await Promise.all([
          langfuse.api.observations.getMany({
            traceId,
            fields: "core,basic,io,metadata,model,usage,prompt,metrics,trace_context",
            limit: 100,
          }, { timeoutInSeconds: 5, maxRetries: 0 }),
          langfuse.api.trace.get(traceId, {}, { timeoutInSeconds: 5, maxRetries: 0 }),
        ]);
        observations = response.data as unknown as Array<JsonRecord>;
        traceDetails = traceResponse as unknown as JsonRecord;
        lastError = null;
        if (observations.length > 0) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) await wait(2_000);
    }
    if (lastError) throw lastError;
    const types = observations.reduce<Record<string, number>>((counts, observation) => {
      const type = String(observation["type"] ?? "UNKNOWN");
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});
    const generations = observations.filter((observation) => observation["type"] === "GENERATION");
    const modelTools = observations.filter((observation) => observation["type"] === "TOOL"
      && String(observation["name"] ?? "").startsWith("agent.tool."));
    const attributedGenerations = generations.filter((observation) => {
      const metadata = observation["metadata"] && typeof observation["metadata"] === "object" && !Array.isArray(observation["metadata"])
        ? observation["metadata"] as JsonRecord
        : {};
      return Boolean(metadata["promptName"] && metadata["promptVersion"] && metadata["promptSha256"]);
    }).length;
    const nativePromptLinkedGenerations = generations.filter((observation) =>
      typeof observation["promptName"] === "string"
      && Number.isSafeInteger(observation["promptVersion"])
      && Number(observation["promptVersion"]) > 0).length;
    const generationsWithUsage = generations.filter((observation) => {
      const usage = observation["usageDetails"];
      return Boolean(usage && typeof usage === "object" && Object.keys(usage).length > 0);
    }).length;
    const generationsWithContextManifest = generations.filter((observation) => {
      const metadata = observation["metadata"] && typeof observation["metadata"] === "object" && !Array.isArray(observation["metadata"])
        ? observation["metadata"] as JsonRecord
        : {};
      return typeof metadata["contextSha256"] === "string"
        && typeof metadata["toolSchemaSha256"] === "string"
        && typeof metadata["phase"] === "string";
    }).length;
    const modelToolsWithCausality = modelTools.filter((observation) => {
      const metadata = observation["metadata"] && typeof observation["metadata"] === "object" && !Array.isArray(observation["metadata"])
        ? observation["metadata"] as JsonRecord
        : {};
      const output = serializedRecord(observation["output"]);
      return typeof metadata["toolCallId"] === "string"
        && typeof metadata["phase"] === "string"
        && Object.hasOwn(output, "modelVisibleResult");
    }).length;
    const traceMetadata = traceDetails["metadata"] && typeof traceDetails["metadata"] === "object" && !Array.isArray(traceDetails["metadata"])
      ? traceDetails["metadata"] as JsonRecord
      : {};
    const requiredCorrelationFields = ["datasetRunName", "datasetItemId", "experimentWrapperTraceId", "trialId", "taskId", "runIndex", "turnIndex"];
    const experimentCorrelationComplete = Boolean(explicitTraceId)
      || requiredCorrelationFields.every((field) => traceMetadata[field] !== undefined && traceMetadata[field] !== "");
    const scoreResponse = await langfuse.api.scoresV3.getManyV3(
      { traceId, fields: "details,subject", limit: 100 },
      { timeoutInSeconds: 5, maxRetries: 1 },
    );
    const scoreNames = scoreResponse.data.map((score) => score.name).filter((name): name is string => Boolean(name)).sort();
    results.push({
      traceId,
      observationCount: observations.length,
      types,
      generationCount: types["GENERATION"] ?? 0,
      attributedGenerations,
      nativePromptLinkedGenerations,
      generationsWithUsage,
      generationsWithContextManifest,
      modelToolCount: modelTools.length,
      modelToolsWithCausality,
      experimentCorrelationComplete,
      hasRootAgent: observations.some((observation) => observation["type"] === "AGENT" && observation["name"] === "execute-turn-attempt"),
      hasTurnRoot: observations.some((observation) => observation["type"] === "CHAIN" && observation["name"] === "conversation-turn"),
      hasCausalityGuardrail: observations.some((observation) => observation["type"] === "GUARDRAIL" && observation["name"] === "validate-agent-tool-causality"),
      scoreCount: scoreNames.length,
      scoreNames,
    });
  }
  const missing = results.filter((result) => result["observationCount"] === 0
    || result["nativePromptLinkedGenerations"] !== result["generationCount"]
    || result["generationsWithUsage"] !== result["generationCount"]
    || result["generationsWithContextManifest"] !== result["generationCount"]
    || result["modelToolsWithCausality"] !== result["modelToolCount"]
    || result["experimentCorrelationComplete"] !== true
    || result["hasRootAgent"] !== true
    || result["hasTurnRoot"] !== true
    || (Number(result["modelToolCount"]) > 0 && result["hasCausalityGuardrail"] !== true));
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), artifactPath, results, missing: missing.length }, null, 2)}\n`);
  if (missing.length > 0) process.exitCode = 1;
} finally {
  await langfuse.shutdown();
}
