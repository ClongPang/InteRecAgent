import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  fingerprintEvaluationAuthoringPlan,
  parseEvaluationAuthoringPlan,
  parseDevelopmentEvaluationCases,
  developmentEvaluationModelFailureCode,
  validateDevelopmentEvaluationCases,
} from "../packages/agent/src/index.js";
import {
  DevelopmentEvaluationTrialExecutor,
  PostgresConversationRepository,
  createPiModelRuntime,
  fetchConversationPrompt,
  parseReplayProviderFixture,
  promptLink,
  evaluationImplementationFingerprint,
  resolveTelemetryConfig,
  runConversationMigrations,
  startTelemetry,
} from "../packages/runtime/src/index.js";

if (process.env["INTEREC_DEVELOPMENT_EVALUATION_CONFIRM"] !== "authorized-deepseek-development-evaluation") {
  throw new Error("INTEREC_DEVELOPMENT_EVALUATION_CONFIRM_MUST_BE_authorized-deepseek-development-evaluation");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_INVALID`);
  return value;
}

const planPath = resolve(process.env["INTEREC_EVALUATION_PLAN_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.json");
const casesPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/development-evaluation-cases.json");
const fixturePath = resolve(process.env["INTEREC_INTERNAL_CAPTURE_PATH"] ?? ".artifacts/evaluation/internal-provider-capture-v1.json");
const outputPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_OUTPUT"] ?? ".artifacts/evaluation/development-evaluation-runs-v1.json");
const plan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync(planPath, "utf8")));
const planHash = fingerprintEvaluationAuthoringPlan(plan);
const casesRaw = readFileSync(casesPath);
const casesSha256 = `sha256:${createHash("sha256").update(casesRaw).digest("hex")}`;
const cases = parseDevelopmentEvaluationCases(JSON.parse(casesRaw.toString("utf8")));
validateDevelopmentEvaluationCases(cases, plan, planHash);
const fixtureRaw = readFileSync(fixturePath);
const fixture = parseReplayProviderFixture(JSON.parse(fixtureRaw.toString("utf8")));
const fixtureSha256 = `sha256:${createHash("sha256").update(fixtureRaw).digest("hex")}`;
const runs = boundedInteger("INTEREC_DEVELOPMENT_EVALUATION_RUNS", 1, 1, 3);
const caseLimit = boundedInteger("INTEREC_DEVELOPMENT_EVALUATION_CASE_LIMIT", cases.cases.length, 1, cases.cases.length);
const taskFilter = process.env["INTEREC_DEVELOPMENT_EVALUATION_TASK"]?.trim() || null;
const taskList = new Set((process.env["INTEREC_DEVELOPMENT_EVALUATION_TASKS"] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const familySample = process.env["INTEREC_DEVELOPMENT_EVALUATION_FAMILY_SAMPLE"] === "1";
const selected = cases.cases
  .filter((entry) => !taskFilter || entry.taskId === taskFilter)
  .filter((entry) => taskList.size === 0 || taskList.has(entry.taskId))
  .filter((entry) => !familySample || entry.taskId.endsWith("-01"))
  .slice(0, caseLimit);
if (selected.length === 0) throw new Error("DEVELOPMENT_EVAL_TASK_FILTER_EMPTY");
if (taskList.size > 0) {
  const missing = [...taskList].filter((taskId) => !selected.some((entry) => entry.taskId === taskId));
  if (missing.length > 0) throw new Error(`DEVELOPMENT_EVAL_TASKS_NOT_SELECTED:${missing.join(",")}`);
}

const databaseUrl = required("INTEREC_DATABASE_URL");
const telemetry = await startTelemetry("interec-development-evaluation");
const repository = new PostgresConversationRepository(databaseUrl);
await runConversationMigrations(repository.pool);
const pi = createPiModelRuntime();
const implementationSha256 = evaluationImplementationFingerprint();
const telemetryConfig = resolveTelemetryConfig();
let langfuse: LangfuseClient | null = null;
let nativePromptLink;
if (process.env["INTEREC_LANGFUSE_PROMPT_REQUIRED"] === "1") {
  if (!telemetryConfig.langfuseEnabled) throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
  langfuse = new LangfuseClient({
    publicKey: telemetryConfig.publicKey!,
    secretKey: telemetryConfig.secretKey!,
    ...(telemetryConfig.baseUrl ? { baseUrl: telemetryConfig.baseUrl } : {}),
  });
  nativePromptLink = promptLink(await fetchConversationPrompt(langfuse));
}
const executor = new DevelopmentEvaluationTrialExecutor(repository, fixture, pi, nativePromptLink ? { promptLink: nativePromptLink } : {});
let output = {
  schemaVersion: "interec-development-evaluation-runs-v1",
  evaluationScope: "DEVELOPMENT_EVALUATION",
  eligibleForResumeMetrics: false,
  planVersion: plan.planVersion,
  planSemanticSha256: planHash,
  fixtureVersion: fixture.fixtureVersion,
  fixtureSha256,
  casesSha256,
  implementationSha256,
  modelId: String(pi.model.id),
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  trials: [] as Array<Record<string, unknown>>,
};
if (process.env["INTEREC_DEVELOPMENT_EVALUATION_RESUME"] === "1" && existsSync(outputPath)) {
  const previous = JSON.parse(readFileSync(outputPath, "utf8")) as typeof output;
  if (previous.schemaVersion !== output.schemaVersion
    || previous.evaluationScope !== "DEVELOPMENT_EVALUATION"
    || previous.eligibleForResumeMetrics !== false
    || previous.planSemanticSha256 !== planHash
    || previous.fixtureSha256 !== fixtureSha256
    || previous.casesSha256 !== casesSha256
    || previous.implementationSha256 !== implementationSha256
    || previous.modelId !== String(pi.model.id)
    || !Array.isArray(previous.trials)) throw new Error("DEVELOPMENT_EVAL_RESUME_FINGERPRINT_MISMATCH");
  output = { ...previous, completedAt: null };
}

function persist(): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

try {
  evaluationRun:
  for (const testCase of selected) {
    for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
      const trialId = `${testCase.taskId}-run-${runIndex}`;
      const priorTrialIndex = output.trials.findIndex((trial) => trial["trialId"] === trialId);
      if (priorTrialIndex >= 0 && output.trials[priorTrialIndex]?.["status"] === "COMPLETED") {
        process.stdout.write(`${JSON.stringify({ trialId, status: "SKIPPED_COMPLETED", failure: null })}\n`);
        continue;
      }
      const trial = await executor.execute(testCase, runIndex);
      if (priorTrialIndex >= 0) output.trials[priorTrialIndex] = trial;
      else output.trials.push(trial);
      const modelFailure = trial.turnEvidence.some((evidence) => {
        const draft = evidence["draft_json"];
        return Boolean(draft && typeof draft === "object" && !Array.isArray(draft)
          && developmentEvaluationModelFailureCode((draft as Record<string, unknown>)["fallbackReasonCode"]));
      });
      persist();
      process.stdout.write(`${JSON.stringify({ trialId, status: trial.status, failure: trial.failure })}\n`);
      if (modelFailure || trial.failure?.startsWith("DEVELOPMENT_EVAL_MODEL_PROVIDER_")) break evaluationRun;
    }
  }
} finally {
  output.completedAt = new Date().toISOString();
  persist();
  await telemetry.forceFlush();
  await repository.close();
  if (langfuse) await langfuse.shutdown();
  await telemetry.shutdown();
}

const completed = output.trials.filter((trial) => trial["status"] === "COMPLETED").length;
process.stdout.write(`${JSON.stringify({ outputPath, trials: output.trials.length, completed, failed: output.trials.length - completed, fixtureSha256 }, null, 2)}\n`);
if (completed !== output.trials.length) process.exitCode = 1;
