import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  developmentEvaluationModelFailureCode,
  evaluateDevelopmentBehaviorAssertions,
  fingerprintEvaluationAuthoringPlan,
  parseDevelopmentEvaluationCases,
  parseEvaluationAuthoringPlan,
} from "../packages/agent/src/index.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INTERNAL_SCORE_INVALID:${label}`);
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function operations(turn: JsonRecord): JsonRecord[] {
  return array(record(turn["plan_json"] ?? {}, "turn.plan_json")["ops"])
    .map((value) => record(value, "turn.operation"));
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
  const goalRevisionValue = finalState["goalRevision"];
  const workingSetValue = finalState["workingSet"];
  if (!workingSetValue) return true;
  const workingSet = record(workingSetValue, "trial.workingSet");
  const poolRefs = new Set(array(workingSet["pool"]).flatMap((candidate) => {
    const item = record(candidate, "trial.workingSet.candidate");
    return typeof item["offerRef"] === "string" ? [item["offerRef"]] : [];
  }));
  const display = strings(workingSet["displayOfferRefs"]);
  const rejected = new Set(strings(workingSet["rejectedOfferRefs"]));
  const allReferencesKnown = [
    ...display,
    ...strings(workingSet["mentionedOfferRefs"]),
    ...strings(workingSet["comparisonOfferRefs"]),
    ...rejected,
    ...(typeof workingSet["focusOfferRef"] === "string" ? [workingSet["focusOfferRef"]] : []),
  ].every((offerRef) => poolRefs.has(offerRef));
  if (!goalRevisionValue) return false;
  const goalRevision = record(goalRevisionValue, "trial.goalRevision");
  return allReferencesKnown
    && display.every((offerRef) => !rejected.has(offerRef))
    && workingSet["boundGoalVersion"] === goalRevision["version"];
}

const inputPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_SCORE_INPUT"] ?? ".artifacts/evaluation/development-evaluation-runs-v1.json");
const outputPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_SCORE_OUTPUT"] ?? ".artifacts/evaluation/development-evaluation-score-v1.json");
const planPath = resolve(process.env["INTEREC_EVALUATION_PLAN_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.json");
const casesPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/development-evaluation-cases.json");

const run = record(JSON.parse(readFileSync(inputPath, "utf8")), "run");
if (run["evaluationScope"] !== "DEVELOPMENT_EVALUATION" || run["eligibleForResumeMetrics"] !== false) {
  throw new Error("INTERNAL_SCORE_BOUNDARY_INVALID");
}
const plan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync(planPath, "utf8")));
if (run["planVersion"] !== plan.planVersion) throw new Error("INTERNAL_SCORE_EVALUATION_PLAN_VERSION_MISMATCH");
if (run["planSemanticSha256"] !== fingerprintEvaluationAuthoringPlan(plan)) throw new Error("INTERNAL_SCORE_EVALUATION_PLAN_HASH_MISMATCH");
const casesRaw = readFileSync(casesPath);
const casesSha256 = `sha256:${createHash("sha256").update(casesRaw).digest("hex")}`;
if (run["casesSha256"] !== casesSha256) throw new Error("INTERNAL_SCORE_CASES_HASH_MISMATCH");
const evaluationCases = parseDevelopmentEvaluationCases(JSON.parse(casesRaw.toString("utf8")));
const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
const caseById = new Map(evaluationCases.cases.map((testCase) => [testCase.taskId, testCase]));

const scored = array(run["trials"]).map((value) => {
  const trial = record(value, "trial");
  const taskId = String(trial["taskId"] ?? "");
  const task = taskById.get(taskId);
  const testCase = caseById.get(taskId);
  if (!task) throw new Error(`INTERNAL_SCORE_TASK_UNKNOWN:${taskId}`);
  if (!testCase) throw new Error(`INTERNAL_SCORE_CASE_UNKNOWN:${taskId}`);
  const turns = array(trial["turnEvidence"]).map((entry) => record(entry, "turnEvidence"));
  const observedOutcomes = turns.flatMap((turn) => typeof turn["outcome"] === "string" ? [turn["outcome"]] : []);
  const fallbackCodes = turns.flatMap((turn) => {
    const draft = record(turn["draft_json"] ?? {}, "turn.draft_json");
    return typeof draft["fallbackReasonCode"] === "string" ? [draft["fallbackReasonCode"]] : [];
  });
  const providerFailureCodes = fallbackCodes.flatMap((reason) => {
    const code = developmentEvaluationModelFailureCode(reason);
    return code ? [code] : [];
  });
  const claimIds = new Set(turns.flatMap((turn) => {
    const ledger = record(turn["ledger_json"] ?? {}, "turn.ledger_json");
    return array(ledger["claims"]).flatMap((claim) => {
      const item = record(claim, "claim");
      return typeof item["claimId"] === "string" ? [item["claimId"]] : [];
    });
  }));
  const searchRows = turns.flatMap((turn) => array(turn["search"]).map((row) => record(row, "search")));
  const disclosures = turns.flatMap((turn) => {
    const envelope = record(turn["envelope_json"] ?? {}, "turn.envelope_json");
    return array(envelope["blocks"]).flatMap((block) => {
      const item = record(block, "envelope.block");
      return item["type"] === "DISCLOSURE" && typeof item["disclosureCode"] === "string" ? [item["disclosureCode"]] : [];
    });
  });
  const finalState = record(trial["finalState"] ?? {}, "trial.finalState");
  const workingSet = finalState["workingSet"] ? record(finalState["workingSet"], "trial.workingSet") : null;
  const displayCount = workingSet ? strings(workingSet["displayOfferRefs"]).length : 0;
  const behaviorAssertions = evaluateDevelopmentBehaviorAssertions(testCase.turnExpectations, turns);
  const validTrial = providerFailureCodes.length === 0;
  const lastCompletedTurn = [...turns].reverse().find((turn) => turn["status"] === "COMPLETED");
  const terminalTurnResolved = Boolean(lastCompletedTurn) && !operations(lastCompletedTurn!).some((operation) =>
    operation["kind"] === "REQUEST_CLARIFICATION"
      && operation["slotId"] === "turn_rephrase"
      && operation["reasonCode"] === "MODEL_PROTOCOL_FAILED");
  const checks = {
    runnerTerminal: trial["status"] === "COMPLETED",
    validTrial,
    noFailedTurn: turns.every((turn) => turn["status"] === "COMPLETED" || turn["status"] === "SUPERSEDED"),
    protocolClean: fallbackCodes.length === 0,
    expectedOutcome: expectedOutcomePassed(task.fixtureOutcome, observedOutcomes, searchRows, disclosures),
    qualifiedOutput: !task.requiresQualifiedOutput || (observedOutcomes.includes("RECOMMENDATION") && displayCount > 0),
    plannedFactsObserved: claimIds.size >= task.minRequiredResponseFields,
    stateEffectsConsistent: stateEffectsConsistent(finalState),
    terminalTurnResolved,
    behaviorInvariants: behaviorAssertions.passed,
  };
  const businessPassed = checks.runnerTerminal
    && checks.validTrial
    && checks.noFailedTurn
    && checks.expectedOutcome
    && checks.qualifiedOutput
    && checks.plannedFactsObserved
    && checks.stateEffectsConsistent
    && checks.terminalTurnResolved
    && checks.behaviorInvariants;
  return {
    trialId: trial["trialId"],
    taskId,
    runIndex: trial["runIndex"],
    passed: businessPassed,
    strictPassed: businessPassed && checks.protocolClean,
    checks,
    observed: {
      outcomes: observedOutcomes,
      fallbackCount: fallbackCodes.length,
      providerFailureCodes,
      claimCount: claimIds.size,
      displayCount,
      behaviorAssertionFailures: behaviorAssertions.failures,
      behaviorAssertionTurnCount: behaviorAssertions.checkedTurnCount,
    },
  };
});

const report = {
  schemaVersion: "interec-development-evaluation-score-v1",
  evaluationScope: "DEVELOPMENT_EVALUATION",
  eligibleForResumeMetrics: false,
  sourceRun: inputPath,
  planVersion: plan.planVersion,
  planSemanticSha256: run["planSemanticSha256"],
  casesSha256,
  fixtureSha256: run["fixtureSha256"],
  implementationSha256: run["implementationSha256"],
  evaluatorSha256: `sha256:${createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex")}`,
  modelId: run["modelId"],
  scoredAt: new Date().toISOString(),
  summary: {
    trials: scored.length,
    validTrials: scored.filter((trial) => trial.checks.validTrial).length,
    invalidProviderTrials: scored.filter((trial) => !trial.checks.validTrial).length,
    passed: scored.filter((trial) => trial.passed).length,
    failed: scored.filter((trial) => trial.checks.validTrial && !trial.passed).length,
    protocolClean: scored.filter((trial) => trial.checks.protocolClean).length,
    recoveredPassed: scored.filter((trial) => trial.passed && !trial.checks.protocolClean).length,
    behaviorInvariantsPassed: scored.filter((trial) => trial.checks.behaviorInvariants).length,
    strictPassed: scored.filter((trial) => trial.strictPassed).length,
  },
  trials: scored,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, ...report.summary }, null, 2)}\n`);
if (report.summary.failed > 0 || report.summary.invalidProviderTrials > 0) process.exitCode = 1;
