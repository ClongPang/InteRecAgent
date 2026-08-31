import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  DEVELOPMENT_EVALUATION_DATASET_NAME,
  deterministicUuidV5,
  resolveTelemetryConfig,
  retryLangfuseControlPlaneRead,
} from "../packages/runtime/src/index.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_INVALID:${label}`);
  return value as JsonRecord;
}

const scoreNames = [
  "development_eval_business_pass",
  "development_eval_protocol_clean",
  "development_eval_expected_outcome",
  "development_eval_state_consistent",
  "development_eval_behavior_invariants",
  "development_eval_trace_complete",
] as const;
const artifactPath = resolve(process.env["INTEREC_LANGFUSE_EXPERIMENT_ARTIFACT"] ?? ".artifacts/evaluation/development-evaluation-langfuse-real-117.json");
const artifact = record(JSON.parse(readFileSync(artifactPath, "utf8")), "artifact");
const datasetName = process.env["INTEREC_LANGFUSE_DATASET_NAME"]?.trim() || DEVELOPMENT_EVALUATION_DATASET_NAME;
const expectedItems = Number(process.env["INTEREC_LANGFUSE_EXPERIMENT_EXPECTED_ITEMS"]?.trim() || 39);
const expectedFingerprints = {
  planSemanticSha256: String(artifact["planSemanticSha256"] ?? ""),
  casesSha256: String(artifact["casesSha256"] ?? ""),
  fixtureSha256: String(artifact["fixtureSha256"] ?? ""),
  implementationSha256: String(artifact["implementationSha256"] ?? ""),
};
for (const [key, value] of Object.entries(expectedFingerprints)) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_FINGERPRINT_INVALID:${key}`);
}
const runs = Array.isArray(artifact["datasetRuns"]) ? artifact["datasetRuns"].map((value) => record(value, "datasetRun")) : [];
if (runs.length === 0) throw new Error("LANGFUSE_EXPERIMENT_CHECK_RUNS_MISSING");

const telemetryConfig = resolveTelemetryConfig();
if (!telemetryConfig.langfuseEnabled) throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
const langfuse = new LangfuseClient({
  publicKey: telemetryConfig.publicKey!,
  secretKey: telemetryConfig.secretKey!,
  ...(telemetryConfig.baseUrl ? { baseUrl: telemetryConfig.baseUrl } : {}),
  timeout: 15,
});

try {
  const summaries = [];
  for (const run of runs) {
    const runName = String(run["runName"] ?? "");
    const expectedRunId = String(run["datasetRunId"] ?? "");
    const fetched = await retryLangfuseControlPlaneRead(() => langfuse.api.datasets.getRun(datasetName, runName), { attempts: 5 });
    if (fetched.id !== expectedRunId) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_RUN_ID_MISMATCH:${runName}`);
    if (fetched.datasetRunItems.length !== expectedItems) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_ITEM_COUNT:${runName}:${fetched.datasetRunItems.length}`);
    const runMetadata = record(fetched.metadata ?? {}, "datasetRun.metadata");
    for (const [key, value] of Object.entries(expectedFingerprints)) {
      if (runMetadata[key] !== value) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_FINGERPRINT_MISMATCH:${runName}:${key}`);
    }
    const traceIds = fetched.datasetRunItems.map((item) => item.traceId);
    const expectedScoreIds = new Set(traceIds.flatMap((traceId) => scoreNames.map((name) =>
      deterministicUuidV5(`experiment-score\0${expectedRunId}\0${traceId}\0${name}`))));
    const scores: Array<{ id: string; name: string; value: unknown }> = [];
    let cursor: string | undefined;
    do {
      const response = await retryLangfuseControlPlaneRead(() => langfuse.api.scoresV3.getManyV3({
        traceId: traceIds.join(","),
        name: scoreNames.join(","),
        fields: "details,subject",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }), { attempts: 5 });
      scores.push(...response.data.filter((score) => expectedScoreIds.has(score.id)));
      cursor = response.meta.cursor;
    } while (cursor);
    const foundIds = new Set(scores.map((score) => score.id));
    const missing = [...expectedScoreIds].filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_SCORE_COUNT:${runName}:${missing.length}`);
    const values = Object.fromEntries(scoreNames.map((name) => {
      const named = scores.filter((score) => score.name === name);
      const one = named.filter((score) => score.value === true || Number(score.value) === 1).length;
      const zero = named.filter((score) => score.value === false || Number(score.value) === 0).length;
      if (one + zero !== expectedItems) throw new Error(`LANGFUSE_EXPERIMENT_CHECK_BOOLEAN_VALUES:${runName}:${name}`);
      return [name, { one, zero }];
    }));
    summaries.push({
      runName,
      datasetRunId: expectedRunId,
      items: traceIds.length,
      scores: scores.length,
      fingerprints: expectedFingerprints,
      values,
    });
  }
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), artifactPath, runs: summaries }, null, 2)}\n`);
} finally {
  await langfuse.shutdown();
}
