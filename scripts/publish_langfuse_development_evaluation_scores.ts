import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  buildDevelopmentEvaluationTraceScorePlan,
  evaluationArtifactFingerprint,
  retryLangfuseControlPlaneRead,
  resolveTelemetryConfig,
} from "../packages/runtime/src/index.js";

const scorePath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_SCORE_OUTPUT"] ?? ".artifacts/evaluation/development-evaluation-score-v1.json");
const runPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_SCORE_INPUT"] ?? ".artifacts/evaluation/development-evaluation-runs-v1.json");
const scoreReport = JSON.parse(readFileSync(scorePath, "utf8"));
const run = JSON.parse(readFileSync(runPath, "utf8"));
const scores = buildDevelopmentEvaluationTraceScorePlan(scoreReport, run);
const summary = {
  schemaVersion: "interec-langfuse-score-publish-v1",
  scoreCount: scores.length,
  traceCount: new Set(scores.map((score) => score.traceId)).size,
  dimensions: [...new Set(scores.map((score) => score.name))].sort(),
  scorePlanSha256: evaluationArtifactFingerprint(scores),
};

if (process.env["INTEREC_LANGFUSE_SCORE_PUBLISH_CONFIRM"] !== "authorized-development-evaluation-scores") {
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
  const expectedScoreIds = new Set(scores.map((score) => score.id));
  const traceIds = [...new Set(scores.map((score) => score.traceId))];
  const scoreNames = [...new Set(scores.map((score) => score.name))];
  let foundScoreIds = new Set<string>();
  for (let pollAttempt = 1; pollAttempt <= 6; pollAttempt += 1) {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await retryLangfuseControlPlaneRead(() => langfuse.api.scoresV3.getManyV3({
        traceId: traceIds.join(","),
        name: scoreNames.join(","),
        fields: "details,subject",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }), { attempts: 5 });
      for (const score of response.data) ids.add(score.id);
      cursor = response.meta.cursor;
    } while (cursor);
    foundScoreIds = ids;
    if ([...expectedScoreIds].every((id) => foundScoreIds.has(id))) break;
    if (pollAttempt < 6) await new Promise((resolveWait) => setTimeout(resolveWait, 2_000 * pollAttempt));
  }
  const missingScoreIds = [...expectedScoreIds].filter((id) => !foundScoreIds.has(id));
  if (missingScoreIds.length > 0) throw new Error(`LANGFUSE_DEVELOPMENT_SCORE_READBACK_MISMATCH:${missingScoreIds.length}`);
  process.stdout.write(`${JSON.stringify({
    mode: "PUBLISHED",
    publishedAt: new Date().toISOString(),
    readbackVerified: true,
    remoteScoreCount: expectedScoreIds.size,
    ...summary,
  }, null, 2)}\n`);
} finally {
  await langfuse.shutdown();
}
