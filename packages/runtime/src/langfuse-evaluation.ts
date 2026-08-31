import { createHash } from "node:crypto";

import {
  evaluateDevelopmentBehaviorAssertions,
  type DevelopmentEvaluationCases,
  type DevelopmentTurnExpectation,
  type EvaluationAuthoringPlan,
  type EvaluationPlanTask,
} from "@interec/agent";

export const DEVELOPMENT_EVALUATION_DATASET_NAME = "interec-agent/development-evaluation/v1";
export const DEVELOPMENT_EVALUATION_EVALUATOR_VERSION = "development-evaluation-v1";

const DATASET_ITEM_NAMESPACE = "7d784350-60f6-50b0-8a04-c6b2d86f2105";

export interface DevelopmentEvaluationDatasetItem {
  id: string;
  datasetName: string;
  input: {
    taskId: string;
    userTurns: string[];
    environmentAction: string;
    fixtureSeed: string;
    focusDisplayRank?: number;
  };
  expectedOutput: {
    fixtureOutcome: EvaluationPlanTask["fixtureOutcome"];
    requiresQualifiedOutput: boolean;
    minRequiredResponseFields: number;
    turns: EvaluationPlanTask["turns"];
    turnExpectations?: DevelopmentTurnExpectation[];
    independentReviewerBrief: string[];
  };
  metadata: {
    family: string;
    title: string;
    businessRisk: string;
    planVersion: string;
    planSemanticSha256: string;
    casesSha256: string;
    fixtureVersion: string;
    fixtureSha256: string;
    capabilities: string[];
    invariants: string[];
    criticalSlices: string[];
    evaluationScope: "DEVELOPMENT_EVALUATION";
    eligibleForResumeMetrics: false;
    privacyClass: "SYNTHETIC_EVALUATION";
    evaluatorVersion: string;
  };
}

export interface DevelopmentEvaluationDatasetBuildOptions {
  datasetName?: string;
  casesSha256: string;
  fixtureVersion: string;
  fixtureSha256: string;
}

export interface DevelopmentEvaluationTraceScore {
  id: string;
  traceId: string;
  name: string;
  value: 0 | 1;
  dataType: "BOOLEAN";
  comment: string;
  metadata: Record<string, unknown>;
}

export interface EvaluationExperimentEvaluation {
  passed: boolean;
  checks: {
    runnerTerminal: boolean;
    noFailedTurn: boolean;
    protocolClean: boolean;
    expectedOutcome: boolean;
    qualifiedOutput: boolean;
    plannedFactsObserved: boolean;
    stateEffectsConsistent: boolean;
    traceComplete: boolean;
    behaviorInvariants: boolean;
  };
  observed: {
    outcomes: string[];
    fallbackCount: number;
    claimCount: number;
    displayCount: number;
    sourceTraceIds: string[];
    behaviorAssertionFailures: string[];
  };
}

type JsonRecord = Record<string, unknown>;

function uuidBytes(value: string): Buffer {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("UUID_NAMESPACE_INVALID");
  return Buffer.from(hex, "hex");
}

export function deterministicUuidV5(name: string, namespace = DATASET_ITEM_NAMESPACE): string {
  const bytes = createHash("sha1").update(uuidBytes(namespace)).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`LANGFUSE_EVAL_INVALID:${label}`);
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function expectedOutcomePassed(outcome: string, observed: string[], searchRows: JsonRecord[], disclosures: string[]): boolean {
  if (outcome === "QUALIFIED_RECOMMENDATION") return observed.includes("RECOMMENDATION");
  if (outcome === "SEARCH_RESULTS_ONLY") return observed.includes("SEARCH_RESULTS") && !observed.includes("RECOMMENDATION");
  if (outcome === "NO_QUALIFIED_OFFER") return observed.includes("NO_MATCH") && !observed.includes("RECOMMENDATION");
  if (outcome === "PARTIAL_RESULT") {
    const partial = searchRows.some((row) => row["wave_status"] === "PARTIAL" || row["market_status"] === "FAILED");
    return partial && disclosures.includes("PARTIAL_PROVIDER_COVERAGE")
      && (observed.includes("RECOMMENDATION") || observed.includes("SEARCH_RESULTS"));
  }
  if (outcome === "PROVIDER_UNAVAILABLE") {
    const completedMarkets = searchRows.filter((row) => row["market_status"] === "COMPLETED").length;
    return completedMarkets === 0 && (observed.includes("NO_MATCH") || observed.includes("DEGRADED"));
  }
  return false;
}

function stateEffectsConsistent(finalState: JsonRecord): boolean {
  const workingSetValue = finalState["workingSet"];
  if (!workingSetValue) return true;
  const workingSet = record(workingSetValue, "trial.workingSet");
  const poolRefs = new Set(array(workingSet["pool"]).flatMap((candidate) => {
    const item = record(candidate, "trial.workingSet.candidate");
    return typeof item["offerRef"] === "string" ? [item["offerRef"]] : [];
  }));
  const display = strings(workingSet["displayOfferRefs"]);
  const rejected = new Set(strings(workingSet["rejectedOfferRefs"]));
  const referencesKnown = [
    ...display,
    ...strings(workingSet["mentionedOfferRefs"]),
    ...strings(workingSet["comparisonOfferRefs"]),
    ...rejected,
    ...(typeof workingSet["focusOfferRef"] === "string" ? [workingSet["focusOfferRef"]] : []),
  ].every((offerRef) => poolRefs.has(offerRef));
  const goalRevision = finalState["goalRevision"] ? record(finalState["goalRevision"], "trial.goalRevision") : null;
  return Boolean(goalRevision)
    && referencesKnown
    && display.every((offerRef) => !rejected.has(offerRef))
    && workingSet["boundGoalVersion"] === goalRevision!["version"];
}

export function evaluateEvaluationExperimentTrial(
  trialValue: unknown,
  expectedValue: unknown,
): EvaluationExperimentEvaluation {
  const trial = record(trialValue, "experiment.trial");
  const expected = record(expectedValue, "experiment.expectedOutput");
  const turns = array(trial["turnEvidence"]).map((value) => record(value, "experiment.turnEvidence"));
  const outcomes = turns.flatMap((turn) => typeof turn["outcome"] === "string" ? [turn["outcome"]] : []);
  const fallbackCodes = turns.flatMap((turn) => {
    const draft = record(turn["draft_json"] ?? {}, "experiment.turn.draft");
    return typeof draft["fallbackReasonCode"] === "string" ? [draft["fallbackReasonCode"]] : [];
  });
  const claimIds = new Set(turns.flatMap((turn) => {
    const ledger = record(turn["ledger_json"] ?? {}, "experiment.turn.ledger");
    return array(ledger["claims"]).flatMap((value) => {
      const claim = record(value, "experiment.claim");
      return typeof claim["claimId"] === "string" ? [claim["claimId"]] : [];
    });
  }));
  const searchRows = turns.flatMap((turn) => array(turn["search"]).map((value) => record(value, "experiment.search")));
  const disclosures = turns.flatMap((turn) => {
    const envelope = record(turn["envelope_json"] ?? {}, "experiment.envelope");
    return array(envelope["blocks"]).flatMap((value) => {
      const block = record(value, "experiment.envelope.block");
      return block["type"] === "DISCLOSURE" && typeof block["disclosureCode"] === "string" ? [block["disclosureCode"]] : [];
    });
  });
  const finalState = record(trial["finalState"] ?? {}, "experiment.finalState");
  const workingSet = finalState["workingSet"] ? record(finalState["workingSet"], "experiment.workingSet") : null;
  const displayCount = workingSet ? strings(workingSet["displayOfferRefs"]).length : 0;
  const sourceTraceIds = turns.map((turn) => String(turn["trace_id"] ?? "")).filter((id) => /^[0-9a-f]{32}$/.test(id));
  const behaviorAssertions = evaluateDevelopmentBehaviorAssertions(
    Array.isArray(expected["turnExpectations"]) ? expected["turnExpectations"] as DevelopmentTurnExpectation[] : undefined,
    turns,
  );
  const fixtureOutcome = String(expected["fixtureOutcome"] ?? "");
  const checks = {
    runnerTerminal: trial["status"] === "COMPLETED",
    noFailedTurn: turns.every((turn) => turn["status"] === "COMPLETED" || turn["status"] === "SUPERSEDED"),
    protocolClean: fallbackCodes.length === 0,
    expectedOutcome: expectedOutcomePassed(fixtureOutcome, outcomes, searchRows, disclosures),
    qualifiedOutput: expected["requiresQualifiedOutput"] !== true || (outcomes.includes("RECOMMENDATION") && displayCount > 0),
    plannedFactsObserved: claimIds.size >= Number(expected["minRequiredResponseFields"] ?? 0),
    stateEffectsConsistent: stateEffectsConsistent(finalState),
    traceComplete: sourceTraceIds.length === turns.length && turns.length > 0,
    behaviorInvariants: behaviorAssertions.passed,
  };
  return {
    passed: checks.runnerTerminal && checks.noFailedTurn && checks.expectedOutcome && checks.qualifiedOutput
      && checks.plannedFactsObserved && checks.stateEffectsConsistent && checks.traceComplete && checks.behaviorInvariants,
    checks,
    observed: {
      outcomes,
      fallbackCount: fallbackCodes.length,
      claimCount: claimIds.size,
      displayCount,
      sourceTraceIds,
      behaviorAssertionFailures: behaviorAssertions.failures,
    },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildDevelopmentEvaluationDatasetItems(
  plan: EvaluationAuthoringPlan,
  cases: DevelopmentEvaluationCases,
  options: DevelopmentEvaluationDatasetBuildOptions,
): DevelopmentEvaluationDatasetItem[] {
  if (cases.planVersion !== plan.planVersion) throw new Error("LANGFUSE_DATASET_EVALUATION_PLAN_VERSION_MISMATCH");
  const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
  if (taskById.size !== cases.cases.length) throw new Error("LANGFUSE_DATASET_CASE_COUNT_MISMATCH");
  const datasetName = options.datasetName ?? DEVELOPMENT_EVALUATION_DATASET_NAME;
  return cases.cases.map((testCase) => {
    const task = taskById.get(testCase.taskId);
    if (!task) throw new Error(`LANGFUSE_DATASET_TASK_UNKNOWN:${testCase.taskId}`);
    return {
      id: deterministicUuidV5(`${datasetName}\0${plan.planVersion}\0${testCase.taskId}`),
      datasetName,
      input: {
        taskId: testCase.taskId,
        userTurns: testCase.userTurns,
        environmentAction: testCase.environmentAction,
        fixtureSeed: testCase.fixtureSeed,
        ...(testCase.focusDisplayRank === undefined ? {} : { focusDisplayRank: testCase.focusDisplayRank }),
      },
      expectedOutput: {
        fixtureOutcome: task.fixtureOutcome,
        requiresQualifiedOutput: task.requiresQualifiedOutput,
        minRequiredResponseFields: task.minRequiredResponseFields,
        turns: task.turns,
        ...(testCase.turnExpectations ? { turnExpectations: testCase.turnExpectations } : {}),
        independentReviewerBrief: task.independentReviewerBrief,
      },
      metadata: {
        family: task.family,
        title: task.title,
        businessRisk: task.businessRisk,
        planVersion: plan.planVersion,
        planSemanticSha256: cases.planSemanticSha256,
        casesSha256: options.casesSha256,
        fixtureVersion: options.fixtureVersion,
        fixtureSha256: options.fixtureSha256,
        capabilities: task.capabilities,
        invariants: task.invariants,
        criticalSlices: task.criticalSlices,
        evaluationScope: "DEVELOPMENT_EVALUATION",
        eligibleForResumeMetrics: false,
        privacyClass: "SYNTHETIC_EVALUATION",
        evaluatorVersion: DEVELOPMENT_EVALUATION_EVALUATOR_VERSION,
      },
    };
  });
}

function scorePlanEntry(
  traceId: string,
  trialId: string,
  taskId: string,
  runIndex: number,
  traceIds: string[],
  evaluatorSha256: string,
  name: string,
  passed: boolean,
): DevelopmentEvaluationTraceScore {
  const value = passed ? 1 : 0;
  return {
    id: deterministicUuidV5(`score\0${traceId}\0${trialId}\0${name}\0${evaluatorSha256}`),
    traceId,
    name,
    value,
    dataType: "BOOLEAN",
    comment: `${DEVELOPMENT_EVALUATION_EVALUATOR_VERSION}: ${name}=${value}`,
    metadata: {
      scope: "multi_turn_trial",
      taskId,
      trialId,
      runIndex,
      sourceTraceIds: traceIds,
      evaluatorVersion: DEVELOPMENT_EVALUATION_EVALUATOR_VERSION,
      evaluatorSha256,
      eligibleForResumeMetrics: false,
    },
  };
}

export function buildDevelopmentEvaluationTraceScorePlan(scoreReportValue: unknown, runValue: unknown): DevelopmentEvaluationTraceScore[] {
  const scoreReport = record(scoreReportValue, "scoreReport");
  const run = record(runValue, "run");
  if (scoreReport["evaluationScope"] !== "DEVELOPMENT_EVALUATION" || scoreReport["eligibleForResumeMetrics"] !== false) {
    throw new Error("LANGFUSE_SCORE_BOUNDARY_INVALID");
  }
  if (run["evaluationScope"] !== "DEVELOPMENT_EVALUATION" || run["eligibleForResumeMetrics"] !== false) {
    throw new Error("LANGFUSE_RUN_BOUNDARY_INVALID");
  }
  for (const key of ["planSemanticSha256", "fixtureSha256", "implementationSha256"] as const) {
    if (scoreReport[key] !== run[key]) throw new Error(`LANGFUSE_SCORE_RUN_MISMATCH:${key}`);
  }
  const evaluatorSha256 = String(scoreReport["evaluatorSha256"] ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(evaluatorSha256)) throw new Error("LANGFUSE_EVALUATOR_HASH_INVALID");
  const runByTrialId = new Map(array(run["trials"]).map((value) => {
    const trial = record(value, "run.trial");
    return [String(trial["trialId"]), trial] as const;
  }));
  return array(scoreReport["trials"]).flatMap((value): DevelopmentEvaluationTraceScore[] => {
    const scored = record(value, "score.trial");
    const trialId = String(scored["trialId"] ?? "");
    const taskId = String(scored["taskId"] ?? "");
    const runTrial = runByTrialId.get(trialId);
    if (!runTrial || String(runTrial["taskId"] ?? "") !== taskId) throw new Error(`LANGFUSE_SCORE_TRIAL_MISSING:${trialId}`);
    const traceIds = array(runTrial["turnEvidence"])
      .map((turn) => String(record(turn, "turnEvidence")["trace_id"] ?? ""))
      .filter((traceId) => /^[0-9a-f]{32}$/.test(traceId));
    if (traceIds.length === 0) throw new Error(`LANGFUSE_SCORE_TRACE_MISSING:${trialId}`);
    const finalTraceId = traceIds.at(-1)!;
    const checks = record(scored["checks"], "score.checks");
    const runIndex = Number(runTrial["runIndex"]);
    if (!Number.isSafeInteger(runIndex) || runIndex < 1) throw new Error(`LANGFUSE_SCORE_RUN_INDEX_INVALID:${trialId}`);
    const dimensions = [
      ["development_eval_business_pass", scored["passed"] === true],
      ["development_eval_protocol_clean", checks["protocolClean"] === true],
      ["development_eval_expected_outcome", checks["expectedOutcome"] === true],
      ["development_eval_state_consistent", checks["stateEffectsConsistent"] === true],
      ["development_eval_behavior_invariants", checks["behaviorInvariants"] === true],
    ] as const;
    return dimensions.map(([name, passed]) => scorePlanEntry(
      finalTraceId,
      trialId,
      taskId,
      runIndex,
      traceIds,
      evaluatorSha256,
      name,
      passed,
    ));
  });
}

export function evaluationArtifactFingerprint(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    if (entry && typeof entry === "object") {
      const item = entry as JsonRecord;
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
    }
    return JSON.stringify(entry);
  };
  return sha256(canonical(value));
}
