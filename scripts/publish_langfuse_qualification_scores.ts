import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  buildQualificationTraceScorePlan,
  qualificationArtifactFingerprint,
  resolveTelemetryConfig,
} from "../packages/runtime/src/index.js";

const scorePath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_SCORE_OUTPUT"] ?? ".artifacts/evaluation/internal-qualification-score-v1.json");
const runPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_SCORE_INPUT"] ?? ".artifacts/evaluation/internal-qualification-runs-v1.json");
const scoreReport = JSON.parse(readFileSync(scorePath, "utf8"));
const run = JSON.parse(readFileSync(runPath, "utf8"));
const scores = buildQualificationTraceScorePlan(scoreReport, run);
const summary = {
  schemaVersion: "interec-langfuse-score-publish-v1",
  scoreCount: scores.length,
  traceCount: new Set(scores.map((score) => score.traceId)).size,
  dimensions: [...new Set(scores.map((score) => score.name))].sort(),
  scorePlanSha256: qualificationArtifactFingerprint(scores),
};

if (process.env["INTEREC_LANGFUSE_SCORE_PUBLISH_CONFIRM"] !== "authorized-internal-qualification-scores") {
  process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN", ...summary }, null, 2)}\n`);
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
  for (const score of scores) langfuse.score.create({ ...score, environment: telemetryConfig.environment });
  await langfuse.flush();
  process.stdout.write(`${JSON.stringify({ mode: "PUBLISHED", publishedAt: new Date().toISOString(), ...summary }, null, 2)}\n`);
} finally {
  await langfuse.shutdown();
}
