import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LangfuseClient } from "@langfuse/client";
import { getActiveTraceId } from "@langfuse/tracing";
import {
  fingerprintEvaluationAuthoringPlan,
  parseEvaluationAuthoringPlan,
  parseDevelopmentEvaluationCases,
  validateDevelopmentEvaluationCases,
} from "../packages/agent/src/index.js";
import {
  DEVELOPMENT_EVALUATION_DATASET_NAME,
  DevelopmentEvaluationTrialExecutor,
  PostgresConversationRepository,
  createPiModelRuntime,
  deterministicUuidV5,
  evaluateEvaluationExperimentTrial,
  fetchConversationPrompt,
  parseReplayProviderFixture,
  promptLink,
  evaluationImplementationFingerprint,
  retryLangfuseControlPlaneRead,
  retryLangfuseIdempotentRequest,
  resolveTelemetryConfig,
  runConversationMigrations,
  startTelemetry,
  type DevelopmentEvaluationTrialArtifact,
} from "../packages/runtime/src/index.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`LANGFUSE_EXPERIMENT_INVALID:${label}`);
  return value as JsonRecord;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function boundedRuns(): number {
  const runs = Number(process.env["INTEREC_DEVELOPMENT_EVALUATION_RUNS"]?.trim() || 3);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 3) throw new Error("INTEREC_DEVELOPMENT_EVALUATION_RUNS_INVALID");
  return runs;
}

function boundedCaseLimit(maximum: number): number {
  const limit = Number(process.env["INTEREC_DEVELOPMENT_EVALUATION_CASE_LIMIT"]?.trim() || maximum);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error("INTEREC_DEVELOPMENT_EVALUATION_CASE_LIMIT_INVALID");
  return limit;
}

const planPath = resolve(process.env["INTEREC_EVALUATION_PLAN_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.json");
const casesPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/development-evaluation-cases.json");
const fixturePath = resolve(process.env["INTEREC_INTERNAL_CAPTURE_PATH"] ?? ".artifacts/evaluation/internal-provider-capture-v1.json");
const outputPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_OUTPUT"] ?? ".artifacts/evaluation/development-evaluation-langfuse-real-117.json");
const datasetName = process.env["INTEREC_LANGFUSE_DATASET_NAME"]?.trim() || DEVELOPMENT_EVALUATION_DATASET_NAME;
const runs = boundedRuns();
const evaluationPlan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync(planPath, "utf8")));
const planHash = fingerprintEvaluationAuthoringPlan(evaluationPlan);
const casesRaw = readFileSync(casesPath);
const casesSha256 = `sha256:${createHash("sha256").update(casesRaw).digest("hex")}`;
const cases = parseDevelopmentEvaluationCases(JSON.parse(casesRaw.toString("utf8")));
validateDevelopmentEvaluationCases(cases, evaluationPlan, planHash);
const taskFilter = process.env["INTEREC_DEVELOPMENT_EVALUATION_TASK"]?.trim() || null;
const selectedCases = cases.cases
  .filter((entry) => !taskFilter || entry.taskId === taskFilter)
  .slice(0, boundedCaseLimit(cases.cases.length));
if (selectedCases.length === 0) throw new Error("DEVELOPMENT_EVAL_TASK_FILTER_EMPTY");
const fixtureRaw = readFileSync(fixturePath);
const fixtureSha256 = `sha256:${createHash("sha256").update(fixtureRaw).digest("hex")}`;
const fixture = parseReplayProviderFixture(JSON.parse(fixtureRaw.toString("utf8")));
const implementationSha256 = evaluationImplementationFingerprint();
const publishPlan = {
  executionMode: "REAL_AGENT_TASK",
  datasetName,
  cases: selectedCases.length,
  runs,
  trials: selectedCases.length * runs,
  planSemanticSha256: planHash,
  casesSha256,
  fixtureSha256,
  implementationSha256,
  outputPath,
  promptAssociation: "LANGFUSE_NATIVE_VERSION",
  scoreReadContract: "SCORES_V3",
};

if (process.env["INTEREC_LANGFUSE_EXPERIMENT_PUBLISH_CONFIRM"] !== "authorized-real-agent-experiment") {
  process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN", ...publishPlan }, null, 2)}\n`);
  process.exit(0);
}

const telemetryConfig = resolveTelemetryConfig();
if (!telemetryConfig.langfuseEnabled) throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
const databaseUrl = required("INTEREC_DATABASE_URL");
const telemetry = await startTelemetry("interec-development-evaluation-real-experiment");
const langfuse = new LangfuseClient({
  publicKey: telemetryConfig.publicKey!,
  secretKey: telemetryConfig.secretKey!,
  ...(telemetryConfig.baseUrl ? { baseUrl: telemetryConfig.baseUrl } : {}),
  timeout: 15,
});
const originalGetTraceUrl = langfuse.getTraceUrl.bind(langfuse);
langfuse.getTraceUrl = (traceId: string) => retryLangfuseControlPlaneRead(
  () => originalGetTraceUrl(traceId),
  { attempts: 5 },
);
const repository = new PostgresConversationRepository(databaseUrl);
await runConversationMigrations(repository.pool);
const pi = createPiModelRuntime();
let nativePrompt;
try {
  nativePrompt = await fetchConversationPrompt(langfuse, { fetchTimeoutMs: 15_000, maxRetries: 3 });
} catch (error) {
  await repository.close();
  await langfuse.shutdown();
  await telemetry.shutdown();
  throw error;
}
const nativePromptLink = promptLink(nativePrompt);
const executor = new DevelopmentEvaluationTrialExecutor(repository, fixture, pi, { promptLink: nativePromptLink });
const caseByTaskId = new Map(selectedCases.map((entry) => [entry.taskId, entry]));
const output = {
  schemaVersion: "interec-development-evaluation-runs-v2",
  evaluationScope: "DEVELOPMENT_EVALUATION",
  eligibleForResumeMetrics: false,
  executionMode: "LANGFUSE_DATASET_EXPERIMENT_REAL_AGENT",
  planVersion: evaluationPlan.planVersion,
  planSemanticSha256: planHash,
  fixtureVersion: fixture.fixtureVersion,
  fixtureSha256,
  casesSha256,
  implementationSha256,
  modelId: String(pi.model.id),
  langfusePrompt: nativePromptLink,
  scoreReadContract: "SCORES_V3",
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  datasetRuns: [] as Array<Record<string, unknown>>,
  trials: [] as DevelopmentEvaluationTrialArtifact[],
};

function persist(): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

const experimentScoreNames = [
  "development_eval_business_pass",
  "development_eval_protocol_clean",
  "development_eval_expected_outcome",
  "development_eval_state_consistent",
  "development_eval_behavior_invariants",
  "development_eval_trace_complete",
] as const;

async function publishAndVerifyScores(
  result: Awaited<ReturnType<typeof langfuse.experiment.run>>,
  runIndex: number,
  runName: string,
  runDescription: string,
  runMetadata: Record<string, unknown>,
): Promise<string> {
  let datasetRunId = result.datasetRunId;
  for (const itemResult of result.itemResults) {
    if (itemResult.datasetRunId) {
      if (datasetRunId && itemResult.datasetRunId !== datasetRunId) throw new Error(`LANGFUSE_EXPERIMENT_DATASET_RUN_SPLIT:${runIndex}`);
      datasetRunId = itemResult.datasetRunId;
      continue;
    }
    if (!("id" in itemResult.item) || !itemResult.item.id || !itemResult.traceId) {
      throw new Error(`LANGFUSE_EXPERIMENT_DATASET_RUN_ITEM_REPAIR_INPUT_MISSING:${runIndex}`);
    }
    const datasetItemId = itemResult.item.id;
    const traceId = itemResult.traceId;
    const repaired = await retryLangfuseIdempotentRequest(() => langfuse.api.datasetRunItems.create({
      runName,
      runDescription,
      metadata: runMetadata,
      datasetItemId,
      traceId,
    }), { attempts: 5 });
    if (datasetRunId && repaired.datasetRunId !== datasetRunId) throw new Error(`LANGFUSE_EXPERIMENT_DATASET_RUN_REPAIR_SPLIT:${runIndex}`);
    datasetRunId = repaired.datasetRunId;
  }
  if (!datasetRunId) throw new Error(`LANGFUSE_EXPERIMENT_DATASET_RUN_LINK_MISSING:${runIndex}`);
  const batch = result.itemResults.flatMap((itemResult) => {
    if (!itemResult.traceId) throw new Error(`LANGFUSE_EXPERIMENT_WRAPPER_TRACE_MISSING:${runIndex}`);
    const traceId = itemResult.traceId;
    const evaluated = record(itemResult.output, "experiment.output");
    const checks = record(evaluated["checks"], "experiment.output.checks");
    const values = {
      development_eval_business_pass: evaluated["passed"] === true,
      development_eval_protocol_clean: checks["protocolClean"] === true,
      development_eval_expected_outcome: checks["expectedOutcome"] === true,
      development_eval_state_consistent: checks["stateEffectsConsistent"] === true,
      development_eval_behavior_invariants: checks["behaviorInvariants"] === true,
      development_eval_trace_complete: checks["traceComplete"] === true,
    };
    return experimentScoreNames.map((name) => {
      const scoreId = deterministicUuidV5(`experiment-score\0${datasetRunId}\0${traceId}\0${name}`);
      return {
        id: deterministicUuidV5(`experiment-score-event\0${scoreId}`),
        type: "score-create" as const,
        timestamp: new Date().toISOString(),
        body: {
          id: scoreId,
          traceId,
          name,
          value: values[name] ? 1 : 0,
          dataType: "BOOLEAN" as const,
          comment: `development-evaluation-v1: ${name}=${values[name] ? 1 : 0}`,
          metadata: {
            datasetRunId,
            runIndex,
            implementationSha256,
            scoreReadContract: "SCORES_V3",
            eligibleForResumeMetrics: false,
          },
        },
      };
    });
  });
  for (let offset = 0; offset < batch.length; offset += 50) {
    const scoreBatch = batch.slice(offset, offset + 50);
    const ingestion = await retryLangfuseIdempotentRequest(
      () => langfuse.api.ingestion.batch({ batch: scoreBatch }),
      { attempts: 5 },
    );
    if (ingestion.errors.length > 0) throw new Error(`LANGFUSE_EXPERIMENT_SCORE_INGESTION_ERRORS:${ingestion.errors.length}`);
  }
  const expectedScoreIds = new Set(batch.map((event) => event.body.id));
  const traceIds = result.itemResults.map((item) => item.traceId!).join(",");
  let found = new Set<string>();
  for (let pollAttempt = 1; pollAttempt <= 6; pollAttempt += 1) {
    try {
      const ids = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await retryLangfuseControlPlaneRead(() => langfuse.api.scoresV3.getManyV3({
          traceId: traceIds,
          name: experimentScoreNames.join(","),
          fields: "details,subject",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }), { attempts: 5 });
        for (const score of response.data) ids.add(score.id);
        cursor = response.meta.cursor;
      } while (cursor);
      found = ids;
      if ([...expectedScoreIds].every((id) => found.has(id))) break;
    } catch (error) {
      if (pollAttempt === 6) throw error;
    }
    if (pollAttempt < 6) await new Promise((resolveWait) => setTimeout(resolveWait, 2_000 * pollAttempt));
  }
  const missing = [...expectedScoreIds].filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`LANGFUSE_EXPERIMENT_SCORES_V3_MISSING:${datasetRunId}:${missing.length}`);
  return datasetRunId;
}

try {
  const dataset = await retryLangfuseControlPlaneRead(() => langfuse.dataset.get(datasetName), { attempts: 5 });
  if (dataset.items.length !== cases.cases.length) throw new Error(`LANGFUSE_EXPERIMENT_DATASET_SIZE_MISMATCH:${dataset.items.length}`);
  const selectedTaskIds = new Set(selectedCases.map((entry) => entry.taskId));
  const selectedDatasetItems = dataset.items.filter((item) => selectedTaskIds.has(String(record(item.input, "dataset.input")["taskId"] ?? "")));
  if (selectedDatasetItems.length !== selectedCases.length) throw new Error(`LANGFUSE_EXPERIMENT_SELECTED_ITEMS_MISSING:${selectedDatasetItems.length}`);
  const executionTag = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    const runName = `development-evaluation-${String(pi.model.id)}-${implementationSha256.slice(7, 15)}-${executionTag}-rep-${runIndex}`;
    const runDescription = "Executes the current multi-turn Agent for every hosted dataset item; this is not an artifact projection.";
    const runMetadata = {
      executionMode: "REAL_AGENT_TASK",
      runIndex,
      modelId: String(pi.model.id),
      planSemanticSha256: planHash,
      casesSha256,
      fixtureSha256,
      implementationSha256,
      promptName: nativePrompt.name,
      promptVersion: nativePrompt.version,
      promptSourceSha256: record(nativePrompt.config, "prompt.config")["sourceSha256"],
      scoreReadContract: "SCORES_V3",
      eligibleForResumeMetrics: false,
    };
    const result = await langfuse.experiment.run({
      name: "InteRecAgent real development evaluation",
      runName,
      description: runDescription,
      metadata: runMetadata,
      data: selectedDatasetItems,
      maxConcurrency: 1,
      task: async (item) => {
        const { input, expectedOutput } = item;
        const datasetInput = record(input, "dataset.input");
        const taskId = String(datasetInput["taskId"] ?? "");
        const testCase = caseByTaskId.get(taskId);
        if (!testCase) throw new Error(`LANGFUSE_EXPERIMENT_TASK_UNKNOWN:${taskId}`);
        if (JSON.stringify(datasetInput["userTurns"]) !== JSON.stringify(testCase.userTurns)
          || datasetInput["environmentAction"] !== testCase.environmentAction
          || datasetInput["fixtureSeed"] !== testCase.fixtureSeed) {
          throw new Error(`LANGFUSE_EXPERIMENT_DATASET_INPUT_DRIFT:${taskId}`);
        }
        const datasetItemId = "id" in item ? String(item.id) : "";
        if (!datasetItemId) throw new Error(`LANGFUSE_EXPERIMENT_DATASET_ITEM_ID_MISSING:${taskId}`);
        const experimentWrapperTraceId = getActiveTraceId();
        if (!experimentWrapperTraceId || !/^[0-9a-f]{32}$/u.test(experimentWrapperTraceId)) {
          throw new Error(`LANGFUSE_EXPERIMENT_WRAPPER_TRACE_CONTEXT_MISSING:${taskId}`);
        }
        const trial = await executor.execute(testCase, runIndex, {
          datasetRunName: runName,
          datasetItemId,
          experimentWrapperTraceId,
        });
        output.trials.push(trial);
        persist();
        const evaluation = evaluateEvaluationExperimentTrial(trial, expectedOutput);
        return { taskId, trialId: trial.trialId, status: trial.status, ...evaluation };
      },
    });
    const datasetRunId = await publishAndVerifyScores(result, runIndex, runName, runDescription, runMetadata);
    for (const trial of output.trials) {
      if (trial.runIndex === runIndex && trial.traceCorrelation?.datasetRunName === runName) {
        trial.traceCorrelation.datasetRunId = datasetRunId;
      }
    }
    persist();
    const datasetRunUrl = result.datasetRunUrl ?? `${(await langfuse.getTraceUrl("mock")).split("/traces")[0]}/datasets/${dataset.id}/runs/${datasetRunId}`;
    output.datasetRuns.push({
      runIndex,
      runName,
      datasetRunId,
      datasetRunUrl,
      items: result.itemResults.length,
    });
    persist();
    process.stdout.write(`${JSON.stringify(output.datasetRuns.at(-1))}\n`);
  }
  output.completedAt = new Date().toISOString();
  persist();
  await langfuse.flush();
  await telemetry.forceFlush({ strict: true });
  const failed = output.trials.filter((trial) => trial.status !== "COMPLETED").length;
  process.stdout.write(`${JSON.stringify({ mode: "EXECUTED", failed, ...publishPlan, datasetRuns: output.datasetRuns }, null, 2)}\n`);
  if (failed > 0) process.exitCode = 1;
} finally {
  if (!output.completedAt) {
    output.completedAt = new Date().toISOString();
    persist();
  }
  await repository.close();
  await langfuse.shutdown();
  await telemetry.shutdown();
}
