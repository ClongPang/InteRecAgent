import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  fingerprintGoldBlueprint,
  parseGoldBlueprint,
  parseInternalQualificationCases,
  validateInternalQualificationCases,
} from "../packages/agent/src/index.js";
import {
  INTERNAL_QUALIFICATION_DATASET_NAME,
  buildInternalQualificationDatasetItems,
  qualificationArtifactFingerprint,
  resolveTelemetryConfig,
} from "../packages/runtime/src/index.js";

const blueprintPath = resolve(process.env["INTEREC_GOLD_BLUEPRINT_PATH"] ?? "spec/evaluation/gold-v1/authoring-blueprint.json");
const casesPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/internal-qualification-cases.json");
const fixturePath = resolve(process.env["INTEREC_INTERNAL_CAPTURE_PATH"] ?? ".artifacts/evaluation/internal-provider-capture-v1.json");
const manifestPath = resolve(process.env["INTEREC_LANGFUSE_DATASET_MANIFEST"] ?? ".artifacts/evaluation/langfuse-dataset-sync-v1.json");
const datasetName = process.env["INTEREC_LANGFUSE_DATASET_NAME"]?.trim() || INTERNAL_QUALIFICATION_DATASET_NAME;

const blueprint = parseGoldBlueprint(JSON.parse(readFileSync(blueprintPath, "utf8")));
const blueprintSemanticSha256 = fingerprintGoldBlueprint(blueprint);
const casesRaw = readFileSync(casesPath);
const casesSha256 = `sha256:${createHash("sha256").update(casesRaw).digest("hex")}`;
const cases = parseInternalQualificationCases(JSON.parse(casesRaw.toString("utf8")));
validateInternalQualificationCases(cases, blueprint, blueprintSemanticSha256);
const fixtureRaw = readFileSync(fixturePath);
const fixtureValue = JSON.parse(fixtureRaw.toString("utf8")) as Record<string, unknown>;
const fixtureVersion = String(fixtureValue["fixtureVersion"] ?? "");
if (!fixtureVersion) throw new Error("LANGFUSE_DATASET_FIXTURE_VERSION_MISSING");
const fixtureSha256 = `sha256:${createHash("sha256").update(fixtureRaw).digest("hex")}`;
const items = buildInternalQualificationDatasetItems(blueprint, cases, {
  datasetName,
  casesSha256,
  fixtureVersion,
  fixtureSha256,
});
const plan = {
  schemaVersion: "interec-langfuse-dataset-sync-v1",
  datasetName,
  blueprintVersion: blueprint.blueprintVersion,
  blueprintSemanticSha256,
  casesSha256,
  fixtureVersion,
  fixtureSha256,
  itemCount: items.length,
  itemIds: items.map((item) => item.id),
  itemPlanSha256: qualificationArtifactFingerprint(items),
};

if (process.env["INTEREC_LANGFUSE_DATASET_SYNC_CONFIRM"] !== "authorized-internal-evaluation-dataset") {
  process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN", ...plan }, null, 2)}\n`);
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
      description: "Versioned multi-turn internal qualification tasks for InteRecAgent. Synthetic evaluation data; not resume evidence.",
      metadata: {
        blueprintVersion: blueprint.blueprintVersion,
        blueprintSemanticSha256,
        qualificationLevel: "INTERNAL_QUALIFICATION",
        eligibleForResumeMetrics: false,
        privacyClass: "SYNTHETIC_EVALUATION",
      },
    });
  }
  for (const item of items) {
    await langfuse.dataset.createItem({ ...item, status: "ACTIVE" });
  }
  await langfuse.flush();
  const manifest = { ...plan, mode: "SYNCED", syncedAt: new Date().toISOString() };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
} finally {
  await langfuse.shutdown();
}
