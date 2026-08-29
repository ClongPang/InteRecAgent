import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { fingerprintGoldBlueprint, parseGoldBlueprint, qualificationModelFailureCode } from "../packages/agent/src/index.js";

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
  return array(record(turn["plan_json"] ?? {}, "turn.plan_json")["ops"]).map((value) => record(value, "turn.operation"));
}

function turnDisclosureCodes(turn: JsonRecord): string[] {
  const envelope = record(turn["envelope_json"] ?? {}, "turn.envelope_json");
  return array(envelope["blocks"]).flatMap((block) => {
    const item = record(block, "turn.envelope.block");
    return item["type"] === "DISCLOSURE" && typeof item["disclosureCode"] === "string"
      ? [item["disclosureCode"]]
      : [];
  });
}

function semanticOperationFailures(messages: string[], turns: JsonRecord[]): string[] {
  const failures: string[] = [];
  for (const [index, message] of messages.entries()) {
    const ops = operations(turns[index] ?? {});
    const kinds = new Set(ops.map((operation) => String(operation["kind"] ?? "")));
    const requireKind = (pattern: RegExp, kind: string, label: string) => {
      if (pattern.test(message) && !kinds.has(kind)) failures.push(`turn_${index + 1}:${label}`);
    };
    const requestsReject = /不要(?!删|移除|排除)|排除(?!其他|其余)|reject/iu.test(message)
      && !/(?:刚才|之前).{0,8}不要.{0,8}(?:恢复|还原)|(?:仍然|继续|依然)不要/iu.test(message);
    if (requestsReject && !kinds.has("REJECT_OFFERS")) failures.push(`turn_${index + 1}:reject_missing`);
    if (/撤销|undo/iu.test(message) && !kinds.has("UNDO_REVISION") && !kinds.has("RESTORE_OFFERS")) {
      failures.push(`turn_${index + 1}:undo_missing`);
    }
    if (/(?:把|将).*(?:恢复|还原)|恢复.*(?:候选|那条)|restore/iu.test(message)
      && !kinds.has("RESTORE_OFFERS") && !kinds.has("UNDO_REVISION")) failures.push(`turn_${index + 1}:restore_missing`);
    const asksCandidateFact = /(?:价格|多少钱|商家|成色|库存|有货|保修|差别|不同|来源|为什么).*(?:多少|什么|哪|谁|差|不同|说说|告诉|确认|解释|\?|？)|(?:为什么|比较|说说|告诉).*(?:价格|商家|成色|库存|有货|保修|差别|不同|来源)|price|merchant|stock|warranty|difference/iu.test(message);
    const priorWorkingSet = index > 0 ? record(turns[index - 1]?.["draft_working_set_json"] ?? {}, "prior.working_set") : null;
    const priorVisibleCandidates = priorWorkingSet ? strings(priorWorkingSet["displayOfferRefs"]).length : 0;
    if (index > 0 && priorVisibleCandidates > 0 && asksCandidateFact && !kinds.has("INSPECT_WORKING_SET")) failures.push(`turn_${index + 1}:inspect_missing`);
    const requestsPriceRerank = /便宜.*(?:排|优先)|低价.*(?:排|优先)|cheaper|lower[ -]?price|price\s+first/iu.test(message)
      && !/(?:取消|移除|不要|不再).{0,8}(?:便宜|低价|价格)/iu.test(message);
    if (requestsPriceRerank) {
      if (!kinds.has("RERANK_WORKING_SET")) failures.push(`turn_${index + 1}:rerank_missing`);
      if (!kinds.has("GOAL_UPSERT_PREFERENCE")) failures.push(`turn_${index + 1}:ranking_preference_missing`);
    }
    requireKind(/只看|范围.*(?:改|收窄)|only\s+(?:look|show|search)/iu, "GOAL_SET_RETRIEVAL_MARKETS", "market_update_missing");
    const requestsRefresh = /刷新.*(?:报价|结果)|重新(?:搜索|查|找)|refresh/iu.test(message)
      && !/(?:别|不要|无需|不必).{0,6}(?:刷新|重新)/u.test(message);
    if (requestsRefresh && !kinds.has("RESEARCH_OFFERS")) failures.push(`turn_${index + 1}:refresh_missing`);
    const asksHistoricalCoverage = /(?:没|没有|未)(?:显示|返回|搜到|检索到).{0,20}(?:当地|市场|卖|销售)|(?:当地|市场).{0,20}(?:没有卖|无售)|(?:market|provider).{0,24}(?:failed|failure|no results|not returned)|does (?:that|this) mean.{0,20}(?:not sold|unavailable)/iu.test(message);
    if (asksHistoricalCoverage) {
      if (!kinds.has("INSPECT_RESEARCH_COVERAGE")) failures.push(`turn_${index + 1}:research_coverage_inspection_missing`);
      if (kinds.has("RESEARCH_OFFERS")) failures.push(`turn_${index + 1}:coverage_question_triggered_research`);
      if (!turnDisclosureCodes(turns[index] ?? {}).some((code) =>
        code === "RESEARCH_COVERAGE_UNKNOWN" || code.startsWith("RESEARCH_COVERAGE_INCOMPLETE:"))) {
        failures.push(`turn_${index + 1}:research_coverage_disclosure_missing`);
      }
    }
    if (/(?:不是.{0,50}(?:是|要)|说错|换成|(?:目标|型号|容量|规格).{0,8}改(?:为|成)|改主意.{0,30}(?:找|要)|correct)/iu.test(message)
      && !kinds.has("GOAL_SET_TARGET")) failures.push(`turn_${index + 1}:target_correction_missing`);
  }
  return failures;
}

function expectedOutcomePassed(outcome: string, observed: string[], researchRows: JsonRecord[], disclosures: string[]): boolean {
  if (outcome === "QUALIFIED_RECOMMENDATION") return observed.includes("RECOMMENDATION");
  if (outcome === "DISCOVERY_ONLY") return observed.includes("DISCOVERY") && !observed.includes("RECOMMENDATION");
  if (outcome === "NO_QUALIFIED_OFFER") return observed.includes("NO_MATCH") && !observed.includes("RECOMMENDATION");
  if (outcome === "PARTIAL_RESULT") {
    const partial = researchRows.some((row) => row["wave_status"] === "PARTIAL" || row["market_status"] === "FAILED");
    return partial && disclosures.includes("PARTIAL_PROVIDER_COVERAGE")
      && (observed.includes("RECOMMENDATION") || observed.includes("DISCOVERY"));
  }
  if (outcome === "PROVIDER_UNAVAILABLE") {
    const completedMarkets = researchRows.filter((row) => row["market_status"] === "COMPLETED").length;
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
  const disjoint = display.every((offerRef) => !rejected.has(offerRef));
  if (!goalRevisionValue) return false;
  const goalRevision = record(goalRevisionValue, "trial.goalRevision");
  return allReferencesKnown && disjoint && workingSet["boundGoalVersion"] === goalRevision["version"];
}

const inputPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_SCORE_INPUT"] ?? ".artifacts/evaluation/internal-qualification-runs-v1.json");
const outputPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_SCORE_OUTPUT"] ?? ".artifacts/evaluation/internal-qualification-score-v1.json");
const blueprintPath = resolve(process.env["INTEREC_GOLD_BLUEPRINT_PATH"] ?? "spec/evaluation/gold-v1/authoring-blueprint.json");
const casesPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/internal-qualification-cases.json");
const run = record(JSON.parse(readFileSync(inputPath, "utf8")), "run");
if (run["qualificationLevel"] !== "INTERNAL_QUALIFICATION" || run["eligibleForResumeMetrics"] !== false) {
  throw new Error("INTERNAL_SCORE_BOUNDARY_INVALID");
}
const blueprint = parseGoldBlueprint(JSON.parse(readFileSync(blueprintPath, "utf8")));
if (run["blueprintVersion"] !== blueprint.blueprintVersion) throw new Error("INTERNAL_SCORE_BLUEPRINT_VERSION_MISMATCH");
if (run["blueprintSemanticSha256"] !== fingerprintGoldBlueprint(blueprint)) throw new Error("INTERNAL_SCORE_BLUEPRINT_HASH_MISMATCH");
const casesSha256 = `sha256:${createHash("sha256").update(readFileSync(casesPath)).digest("hex")}`;
if (run["casesSha256"] !== casesSha256) throw new Error("INTERNAL_SCORE_CASES_HASH_MISMATCH");

const taskById = new Map(blueprint.tasks.map((task) => [task.taskId, task]));
const scored = array(run["trials"]).map((value) => {
  const trial = record(value, "trial");
  const taskId = String(trial["taskId"] ?? "");
  const task = taskById.get(taskId);
  if (!task) throw new Error(`INTERNAL_SCORE_TASK_UNKNOWN:${taskId}`);
  const turns = array(trial["turnEvidence"]).map((entry) => record(entry, "turnEvidence"));
  const observedOutcomes = turns.flatMap((turn) => typeof turn["outcome"] === "string" ? [turn["outcome"]] : []);
  const fallbackCodes = turns.flatMap((turn) => {
    const draft = record(turn["draft_json"] ?? {}, "turn.draft_json");
    return typeof draft["fallbackReasonCode"] === "string" ? [draft["fallbackReasonCode"]] : [];
  });
  const providerFailureCodes = fallbackCodes.flatMap((reason) => {
    const code = qualificationModelFailureCode(reason);
    return code ? [code] : [];
  });
  const claimIds = new Set(turns.flatMap((turn) => {
    const ledger = record(turn["ledger_json"] ?? {}, "turn.ledger_json");
    return array(ledger["claims"]).flatMap((claim) => {
      const item = record(claim, "claim");
      return typeof item["claimId"] === "string" ? [item["claimId"]] : [];
    });
  }));
  const researchRows = turns.flatMap((turn) => array(turn["research"]).map((row) => record(row, "research")));
  const disclosures = turns.flatMap((turn) => {
    const envelope = record(turn["envelope_json"] ?? {}, "turn.envelope_json");
    return array(envelope["blocks"]).flatMap((block) => {
      const item = record(block, "envelope.block");
      return item["type"] === "DISCLOSURE" && typeof item["disclosureCode"] === "string" ? [item["disclosureCode"]] : [];
    });
  });
  const messages = strings(trial["userTurns"]);
  const finalState = record(trial["finalState"] ?? {}, "trial.finalState");
  const workingSet = finalState["workingSet"] ? record(finalState["workingSet"], "trial.workingSet") : null;
  const displayCount = workingSet ? strings(workingSet["displayOfferRefs"]).length : 0;
  const semanticFailures = semanticOperationFailures(messages, turns);
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
    expectedOutcome: expectedOutcomePassed(task.fixtureOutcome, observedOutcomes, researchRows, disclosures),
    qualifiedOutput: !task.requiresQualifiedOutput || (observedOutcomes.includes("RECOMMENDATION") && displayCount > 0),
    plannedFactsObserved: claimIds.size >= task.minRequiredFacts,
    stateEffectsConsistent: stateEffectsConsistent(finalState),
    terminalTurnResolved,
    operationTraceDiagnostic: semanticFailures.length === 0,
  };
  const businessPassed = checks.runnerTerminal
    && checks.validTrial
    && checks.noFailedTurn
    && checks.expectedOutcome
    && checks.qualifiedOutput
    && checks.plannedFactsObserved
    && checks.stateEffectsConsistent
    && checks.terminalTurnResolved;
  return {
    trialId: trial["trialId"],
    taskId,
    runIndex: trial["runIndex"],
    passed: businessPassed,
    strictPassed: businessPassed && checks.protocolClean,
    checks,
    observed: { outcomes: observedOutcomes, fallbackCount: fallbackCodes.length, providerFailureCodes, claimCount: claimIds.size, displayCount, operationDiagnostics: semanticFailures },
  };
});

const report = {
  schemaVersion: "interec-internal-qualification-score-v1",
  qualificationLevel: "INTERNAL_QUALIFICATION",
  eligibleForResumeMetrics: false,
  sourceRun: inputPath,
  blueprintVersion: blueprint.blueprintVersion,
  blueprintSemanticSha256: run["blueprintSemanticSha256"],
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
    operationDiagnosticsClean: scored.filter((trial) => trial.checks.operationTraceDiagnostic).length,
    strictPassed: scored.filter((trial) => trial.strictPassed).length,
  },
  trials: scored,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, ...report.summary }, null, 2)}\n`);
if (report.summary.failed > 0 || report.summary.invalidProviderTrials > 0) process.exitCode = 1;
