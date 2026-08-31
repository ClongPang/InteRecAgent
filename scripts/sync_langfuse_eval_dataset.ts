import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  fingerprintEvaluationAuthoringPlan,
  parseEvaluationAuthoringPlan,
  parseDevelopmentEvaluationCases,
  validateDevelopmentEvaluationCases,
} from "../packages/agent/src/index.js";
import {
  DEVELOPMENT_EVALUATION_DATASET_NAME,
  buildDevelopmentEvaluationDatasetItems,
  evaluationArtifactFingerprint,
  retryLangfuseControlPlaneRead,
  resolveTelemetryConfig,
} from "../packages/runtime/src/index.js";

const planPath = resolve(process.env["INTEREC_EVALUATION_PLAN_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.json");
const casesPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/development-evaluation-cases.json");
const fixturePath = resolve(process.env["INTEREC_INTERNAL_CAPTURE_PATH"] ?? ".artifacts/evaluation/internal-provider-capture-v1.json");
const manifestPath = resolve(process.env["INTEREC_LANGFUSE_DATASET_MANIFEST"] ?? ".artifacts/evaluation/langfuse-dataset-sync-v1.json");
const datasetName = process.env["INTEREC_LANGFUSE_DATASET_NAME"]?.trim() || DEVELOPMENT_EVALUATION_DATASET_NAME;

const evaluationPlan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync(planPath, "utf8")));
const planSemanticSha256 = fingerprintEvaluationAuthoringPlan(evaluationPlan);
const casesRaw = readFileSync(casesPath);
const casesSha256 = `sha256:${createHash("sha256").update(casesRaw).digest("hex")}`;
const cases = parseDevelopmentEvaluationCases(JSON.parse(casesRaw.toString("utf8")));
validateDevelopmentEvaluationCases(cases, evaluationPlan, planSemanticSha256);
const fixtureRaw = readFileSync(fixturePath);
const fixtureValue = JSON.parse(fixtureRaw.toString("utf8")) as Record<string, unknown>;
const fixtureVersion = String(fixtureValue["fixtureVersion"] ?? "");
if (!fixtureVersion) throw new Error("LANGFUSE_DATASET_FIXTURE_VERSION_MISSING");
const fixtureSha256 = `sha256:${createHash("sha256").update(fixtureRaw).digest("hex")}`;
const items = buildDevelopmentEvaluationDatasetItems(evaluationPlan, cases, {
  datasetName,
  casesSha256,
  fixtureVersion,
  fixtureSha256,
});
const syncPlan = {
  schemaVersion: "interec-langfuse-dataset-sync-v1",
  datasetName,
  planVersion: evaluationPlan.planVersion,
  planSemanticSha256,
  casesSha256,
  fixtureVersion,
  fixtureSha256,
  itemCount: items.length,
  itemIds: items.map((item) => item.id),
  itemPlanSha256: evaluationArtifactFingerprint(items),
};

if (process.env["INTEREC_LANGFUSE_DATASET_SYNC_CONFIRM"] !== "authorized-internal-evaluation-dataset") {
  process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN", ...syncPlan }, null, 2)}\n`);
  process.exit(0);
}

const telemetryConfig = resolveTelemetryConfig();
if (!telemetryConfig.langfuseEnabled) throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
const langfuse = new LangfuseClient({
  publicKey: telemetryConfig.publicKey!,
  secretKey: telemetryConfig.secretKey!,
  ...(telemetryConfig.baseUrl ? { baseUrl: telemetryConfig.baseUrl } : {}),
});
try {
  try {
    await langfuse.api.datasets.get(datasetName);
  } catch (error) {
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : null;
    if (statusCode !== 404) throw error;
    await langfuse.api.datasets.create({
      name: datasetName,
      description: "Versioned multi-turn development evaluation tasks for InteRecAgent. Synthetic evaluation data; not resume evidence.",
      metadata: {
        planVersion: evaluationPlan.planVersion,
        planSemanticSha256,
        evaluationScope: "DEVELOPMENT_EVALUATION",
        eligibleForResumeMetrics: false,
        privacyClass: "SYNTHETIC_EVALUATION",
      },
    });
  }
  for (const item of items) {
    await langfuse.dataset.createItem({ ...item, status: "ACTIVE" });
  }
  await langfuse.flush();
  const remoteDataset = await retryLangfuseControlPlaneRead(() => langfuse.dataset.get(datasetName), { attempts: 5 });
  const expectedItemIds = new Set(items.map((item) => item.id));
  const remoteItemIds = new Set(remoteDataset.items.map((item) => item.id));
  const missingItemIds = [...expectedItemIds].filter((id) => !remoteItemIds.has(id));
  const unexpectedItemIds = [...remoteItemIds].filter((id) => !expectedItemIds.has(id));
  if (missingItemIds.length > 0 || unexpectedItemIds.length > 0 || remoteDataset.items.length !== items.length) {
    throw new Error(`LANGFUSE_DATASET_READBACK_MISMATCH:missing=${missingItemIds.length}:unexpected=${unexpectedItemIds.length}:count=${remoteDataset.items.length}`);
  }
  const manifest = {
    ...syncPlan,
    mode: "SYNCED",
    syncedAt: new Date().toISOString(),
    remoteDatasetId: remoteDataset.id,
    remoteItemCount: remoteDataset.items.length,
    readbackVerified: true,
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
} finally {
  await langfuse.shutdown();
}
