import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import {
  fingerprintGoldBlueprint,
  parseGoldBlueprint,
  parseInternalQualificationCases,
  qualificationModelFailureCode,
  validateInternalQualificationCases,
} from "../packages/agent/src/index.js";
import {
  InternalQualificationTrialExecutor,
  PostgresConversationRepository,
  createPiModelRuntime,
  fetchConversationPrompt,
  parseReplayProviderFixture,
  promptLink,
  qualificationImplementationFingerprint,
  resolveTelemetryConfig,
  runConversationMigrations,
  startTelemetry,
} from "../packages/runtime/src/index.js";

if (process.env["INTEREC_INTERNAL_QUALIFICATION_CONFIRM"] !== "authorized-deepseek-internal-qualification") {
  throw new Error("INTEREC_INTERNAL_QUALIFICATION_CONFIRM_MUST_BE_authorized-deepseek-internal-qualification");
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

const blueprintPath = resolve(process.env["INTEREC_GOLD_BLUEPRINT_PATH"] ?? "spec/evaluation/gold-v1/authoring-blueprint.json");
const casesPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/internal-qualification-cases.json");
const fixturePath = resolve(process.env["INTEREC_INTERNAL_CAPTURE_PATH"] ?? ".artifacts/evaluation/internal-provider-capture-v1.json");
const outputPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_OUTPUT"] ?? ".artifacts/evaluation/internal-qualification-runs-v1.json");
const blueprint = parseGoldBlueprint(JSON.parse(readFileSync(blueprintPath, "utf8")));
const blueprintHash = fingerprintGoldBlueprint(blueprint);
const casesRaw = readFileSync(casesPath);
const casesSha256 = `sha256:${createHash("sha256").update(casesRaw).digest("hex")}`;
const cases = parseInternalQualificationCases(JSON.parse(casesRaw.toString("utf8")));
validateInternalQualificationCases(cases, blueprint, blueprintHash);
const fixtureRaw = readFileSync(fixturePath);
const fixture = parseReplayProviderFixture(JSON.parse(fixtureRaw.toString("utf8")));
const fixtureSha256 = `sha256:${createHash("sha256").update(fixtureRaw).digest("hex")}`;
const runs = boundedInteger("INTEREC_INTERNAL_QUALIFICATION_RUNS", 1, 1, 3);
const caseLimit = boundedInteger("INTEREC_INTERNAL_QUALIFICATION_CASE_LIMIT", cases.cases.length, 1, cases.cases.length);
const taskFilter = process.env["INTEREC_INTERNAL_QUALIFICATION_TASK"]?.trim() || null;
const taskList = new Set((process.env["INTEREC_INTERNAL_QUALIFICATION_TASKS"] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const familySample = process.env["INTEREC_INTERNAL_QUALIFICATION_FAMILY_SAMPLE"] === "1";
const selected = cases.cases
  .filter((entry) => !taskFilter || entry.taskId === taskFilter)
  .filter((entry) => taskList.size === 0 || taskList.has(entry.taskId))
  .filter((entry) => !familySample || entry.taskId.endsWith("-01"))
  .slice(0, caseLimit);
if (selected.length === 0) throw new Error("QUALIFICATION_TASK_FILTER_EMPTY");
if (taskList.size > 0) {
  const missing = [...taskList].filter((taskId) => !selected.some((entry) => entry.taskId === taskId));
  if (missing.length > 0) throw new Error(`QUALIFICATION_TASKS_NOT_SELECTED:${missing.join(",")}`);
}

const databaseUrl = required("INTEREC_DATABASE_URL");
const telemetry = await startTelemetry("interec-internal-qualification");
const repository = new PostgresConversationRepository(databaseUrl);
await runConversationMigrations(repository.pool);
const pi = createPiModelRuntime();
const implementationSha256 = qualificationImplementationFingerprint();
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
const executor = new InternalQualificationTrialExecutor(repository, fixture, pi, nativePromptLink ? { promptLink: nativePromptLink } : {});
let output = {
  schemaVersion: "interec-internal-qualification-runs-v1",
  qualificationLevel: "INTERNAL_QUALIFICATION",
  eligibleForResumeMetrics: false,
  blueprintVersion: blueprint.blueprintVersion,
  blueprintSemanticSha256: blueprintHash,
  fixtureVersion: fixture.fixtureVersion,
  fixtureSha256,
  casesSha256,
  implementationSha256,
  modelId: String(pi.model.id),
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  trials: [] as Array<Record<string, unknown>>,
};
if (process.env["INTEREC_INTERNAL_QUALIFICATION_RESUME"] === "1" && existsSync(outputPath)) {
  const previous = JSON.parse(readFileSync(outputPath, "utf8")) as typeof output;
  if (previous.schemaVersion !== output.schemaVersion
    || previous.qualificationLevel !== "INTERNAL_QUALIFICATION"
    || previous.eligibleForResumeMetrics !== false
    || previous.blueprintSemanticSha256 !== blueprintHash
    || previous.fixtureSha256 !== fixtureSha256
    || previous.casesSha256 !== casesSha256
    || previous.implementationSha256 !== implementationSha256
    || previous.modelId !== String(pi.model.id)
    || !Array.isArray(previous.trials)) throw new Error("QUALIFICATION_RESUME_FINGERPRINT_MISMATCH");
  output = { ...previous, completedAt: null };
}

function persist(): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

let abortedForModelProvider = false;
try {
  qualificationRun:
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
          && qualificationModelFailureCode((draft as Record<string, unknown>)["fallbackReasonCode"]));
      });
      abortedForModelProvider = modelFailure || Boolean(trial.failure?.startsWith("QUALIFICATION_MODEL_PROVIDER_"));
      persist();
      process.stdout.write(`${JSON.stringify({ trialId, status: trial.status, failure: trial.failure })}\n`);
      if (abortedForModelProvider) break qualificationRun;
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
