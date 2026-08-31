import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  executeConversationTurn,
  toolNameForOperation,
  type AssistantEnvelopeProposal,
  type ContextMessage,
  type ProposedTurnOperation,
  type TurnExecutionController,
  type TurnPlanProposal,
} from "../packages/agent/src/index.js";
import {
  applyGoalOperations,
  rejectWorkingSetOffers,
  resolveReferents,
  restoreWorkingSetOffers,
  setWorkingSetComparison,
  setWorkingSetFocus,
  validateTurnPlan,
  type CandidateReferent,
  type ConversationRoute,
  type ConversationState,
  type GoalOperation,
  type ShoppingGoal,
  type TurnOperation,
  type TurnPlan,
  type WorkingSet,
} from "../packages/domain/src/index.js";
import { createPiModelRuntime } from "../packages/runtime/src/model-factory.js";

type JsonRecord = Record<string, unknown>;
type Arm = "PROJECTED" | "FULL_TRANSCRIPT";

interface ExpectedReferent {
  operationKind: string;
  offerRefs: string[];
}

interface ContextCase {
  caseId: string;
  currentUserMessage: string;
  uiFocusOfferRef?: string;
  initialRejectedOfferRefs?: string[];
  expectedGoalPatch: {
    budget?: { amount: string; currency: string } | null;
    retrievalMarkets?: string[];
    stockPreference?: "ANY" | "KNOWN_IN_STOCK";
    removeHardConstraintKeys?: string[];
  };
  expectedReferents: ExpectedReferent[];
}

interface ContextSpec {
  schemaVersion: "interec-context-ablation-v1";
  evaluationScope: "DEVELOPMENT_CONTEXT_ABLATION";
  eligibleForResumeMetrics: false;
  repeats: number;
  commonHistory: ContextMessage[];
  cases: ContextCase[];
}

interface TrialResult {
  trialId: string;
  caseId: string;
  runIndex: number;
  arm: Arm;
  status: "VALID" | "INVALID";
  failure: string | null;
  stateCorrect: boolean;
  referentCorrect: number;
  referentTotal: number;
  modelUsage: {
    responses: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  } | null;
  projectedContextEstimatedTokens: number | null;
  operationKinds: string[];
  expectedGoal: JsonRecord;
  actualGoal: JsonRecord | null;
  expectedReferents: ExpectedReferent[];
  actualReferents: Array<{ operationKind: string; offerRefs: string[] }>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`CONTEXT_EVAL_INVALID:${label}`);
  return value as JsonRecord;
}

function parseSpec(value: unknown): ContextSpec {
  const item = record(value, "spec");
  if (item["schemaVersion"] !== "interec-context-ablation-v1"
    || item["evaluationScope"] !== "DEVELOPMENT_CONTEXT_ABLATION"
    || item["eligibleForResumeMetrics"] !== false) throw new Error("CONTEXT_EVAL_SPEC_BOUNDARY_INVALID");
  if (!Number.isSafeInteger(item["repeats"]) || Number(item["repeats"]) < 1 || Number(item["repeats"]) > 10) {
    throw new Error("CONTEXT_EVAL_REPEATS_INVALID");
  }
  if (!Array.isArray(item["commonHistory"]) || !Array.isArray(item["cases"])) throw new Error("CONTEXT_EVAL_CASES_INVALID");
  const commonHistory = item["commonHistory"].map((value, index): ContextMessage => {
    const message = record(value, `commonHistory.${index}`);
    if ((message["role"] !== "USER" && message["role"] !== "ASSISTANT") || typeof message["content"] !== "string") {
      throw new Error(`CONTEXT_EVAL_HISTORY_INVALID:${index}`);
    }
    return { role: message["role"], content: message["content"] };
  });
  const cases = item["cases"].map((value, index): ContextCase => {
    const testCase = record(value, `cases.${index}`);
    if (typeof testCase["caseId"] !== "string" || typeof testCase["currentUserMessage"] !== "string") {
      throw new Error(`CONTEXT_EVAL_CASE_INVALID:${index}`);
    }
    const expectedGoalPatch = record(testCase["expectedGoalPatch"], `cases.${index}.expectedGoalPatch`) as ContextCase["expectedGoalPatch"];
    if (!Array.isArray(testCase["expectedReferents"])) throw new Error(`CONTEXT_EVAL_REFERENTS_INVALID:${index}`);
    const expectedReferents = testCase["expectedReferents"].map((entry, referentIndex): ExpectedReferent => {
      const expected = record(entry, `cases.${index}.expectedReferents.${referentIndex}`);
      if (typeof expected["operationKind"] !== "string" || !Array.isArray(expected["offerRefs"])
        || !expected["offerRefs"].every((offerRef) => typeof offerRef === "string")) {
        throw new Error(`CONTEXT_EVAL_REFERENT_INVALID:${index}:${referentIndex}`);
      }
      return { operationKind: expected["operationKind"], offerRefs: expected["offerRefs"] as string[] };
    });
    return {
      caseId: testCase["caseId"],
      currentUserMessage: testCase["currentUserMessage"],
      ...(typeof testCase["uiFocusOfferRef"] === "string" ? { uiFocusOfferRef: testCase["uiFocusOfferRef"] } : {}),
      ...(Array.isArray(testCase["initialRejectedOfferRefs"])
        ? { initialRejectedOfferRefs: testCase["initialRejectedOfferRefs"].filter((entry): entry is string => typeof entry === "string") }
        : {}),
      expectedGoalPatch,
      expectedReferents,
    };
  });
  const ids = new Set(cases.map((testCase) => testCase.caseId));
  if (ids.size !== cases.length) throw new Error("CONTEXT_EVAL_CASE_ID_DUPLICATE");
  return {
    schemaVersion: "interec-context-ablation-v1",
    evaluationScope: "DEVELOPMENT_CONTEXT_ABLATION",
    eligibleForResumeMetrics: false,
    repeats: Number(item["repeats"]),
    commonHistory,
    cases,
  };
}

const source = { messageId: "context-eval-history" };

function baseGoal(): ShoppingGoal {
  return {
    target: {
      categoryId: "headphones",
      targetText: "索尼 WH-1000XM5 降噪耳机",
      canonicalModel: "WH-1000XM5",
      itemRole: "PRIMARY_PRODUCT",
      condition: "NEW",
    },
    budget: { amount: "3000", currency: "CNY" },
    retrievalMarkets: ["US", "JP"],
    deliveryDestination: "CN",
    stockPreference: "KNOWN_IN_STOCK",
    hardConstraints: [
      { key: "noise_cancelling", operator: "EQ", value: true, source },
      { key: "color", operator: "EQ", value: "black", source },
    ],
    preferences: [
      { key: "use_case", value: "commute", weight: 0.8, source },
      { key: "price", value: "LOWER", weight: 0.7, source },
    ],
    exclusions: [],
    unresolved: [],
  };
}

function candidate(offerRef: string, merchant: string, market: string, amount: string, stock: "IN_STOCK" | "UNKNOWN") {
  return {
    offerRef,
    title: `Sony WH-1000XM5 ${merchant}`,
    canonicalModel: "WH-1000XM5",
    categoryId: "headphones",
    itemRole: "PRIMARY_PRODUCT" as const,
    condition: "NEW" as const,
    retrievalMarket: market,
    merchant,
    cnyAmount: amount,
    stock,
    claimIds: [`claim:${offerRef}:price`, `claim:${offerRef}:stock`],
    marketEvidenceLevel: "PROVIDER_ATTESTED" as const,
    rankingReasonCodes: ["TARGET_MATCH", "PRICE_ASC"],
  };
}

function initialWorkingSet(testCase: ContextCase): WorkingSet {
  const rejected = testCase.initialRejectedOfferRefs ?? [];
  const pool = [
    candidate("offer-a", "Alpha", "US", "2380", "IN_STOCK"),
    candidate("offer-b", "Beta", "JP", "2510", "IN_STOCK"),
    candidate("offer-c", "Gamma", "US", "2790", "UNKNOWN"),
    candidate("offer-d", "Delta", "JP", "2950", "IN_STOCK"),
  ];
  return {
    version: 9,
    boundGoalVersion: 7,
    pool,
    displayOfferRefs: pool.map((item) => item.offerRef).filter((offerRef) => !rejected.includes(offerRef)),
    mentionedOfferRefs: ["offer-a", "offer-b", "offer-c", "offer-d"],
    comparisonOfferRefs: [],
    rejectedOfferRefs: [...rejected],
    focusOfferRef: "offer-c",
  };
}

function initialState(testCase: ContextCase): ConversationState {
  return {
    revision: 14,
    status: "OPEN",
    goalRevision: {
      version: 7,
      parentVersion: 6,
      goal: baseGoal(),
      operations: [],
      committedByTurnId: "context-eval-prior-turn",
    },
    dialogue: {
      pendingClarification: null,
      pendingOps: [],
      focusOfferRef: "offer-c",
      comparisonOfferRefs: [],
      lastAssistantMessageId: "context-eval-prior-assistant",
    },
    workingSet: initialWorkingSet(testCase),
  };
}

function expectedGoal(testCase: ContextCase): ShoppingGoal {
  const goal = structuredClone(baseGoal());
  const patch = testCase.expectedGoalPatch;
  if (Object.hasOwn(patch, "budget")) goal.budget = patch.budget ?? null;
  if (patch.retrievalMarkets) goal.retrievalMarkets = [...patch.retrievalMarkets];
  if (patch.stockPreference) goal.stockPreference = patch.stockPreference;
  if (patch.removeHardConstraintKeys) {
    const removed = new Set(patch.removeHardConstraintKeys);
    goal.hardConstraints = goal.hardConstraints.filter((constraint) => !removed.has(constraint.key));
  }
  return goal;
}

function publicGoal(goal: ShoppingGoal): JsonRecord {
  return {
    target: goal.target,
    budget: goal.budget,
    retrievalMarkets: [...goal.retrievalMarkets].sort(),
    deliveryDestination: goal.deliveryDestination,
    stockPreference: goal.stockPreference,
    hardConstraints: goal.hardConstraints
      .map(({ source: _source, ...constraint }) => constraint)
      .sort((left, right) => left.key.localeCompare(right.key)),
    preferences: goal.preferences
      .map(({ source: _source, ...preference }) => preference)
      .sort((left, right) => left.key.localeCompare(right.key)),
    exclusions: [...goal.exclusions].sort((left, right) => `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)),
    unresolved: goal.unresolved.map(({ askedByMessageId: _messageId, ...gap }) => gap).sort((left, right) => left.slotId.localeCompare(right.slotId)),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bindProposal(proposal: TurnPlanProposal): TurnPlan {
  const bind = (operation: ProposedTurnOperation): TurnOperation => {
    const value = operation as ProposedTurnOperation & { sourceMessageOrdinal?: number; sourceSpan?: { start: number; end: number } };
    const { sourceMessageOrdinal, sourceSpan, ...rest } = value;
    if (operation.kind.startsWith("GOAL_")) {
      if (sourceMessageOrdinal !== 0) throw new Error("CONTEXT_EVAL_SOURCE_ORDINAL_INVALID");
      return { ...rest, source: { messageId: "context-eval-current", ...(sourceSpan ? { span: sourceSpan } : {}) } } as TurnOperation;
    }
    return rest as TurnOperation;
  };
  return validateTurnPlan({
    userIntentSummary: proposal.userIntentSummary,
    ops: proposal.ops.map(bind),
    leftover: proposal.leftover.map((pending) => ({ conditionCode: pending.conditionCode, operation: bind(pending.operation) })),
  });
}

function routeFor(plan: TurnPlan): ConversationRoute {
  if (plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS")) return "search";
  if (plan.ops.some((operation) => operation.kind === "REQUEST_CLARIFICATION")) return "clarify";
  if (plan.ops.some((operation) => operation.kind === "REFILTER_WORKING_SET")) return "refilter";
  if (plan.ops.some((operation) => operation.kind === "SORT_WORKING_SET_BY_PRICE")) return "sort";
  return "talk";
}

function controllerHarness() {
  let committedPlan: TurnPlan | null = null;
  const controller: TurnExecutionController = {
    commitPlan: async (proposal) => {
      committedPlan = bindProposal(proposal);
      return { plan: committedPlan, route: routeFor(committedPlan), maxModelInferences: 2 };
    },
    executeOperation: async (operation) => ({
      opId: operation.opId,
      toolName: toolNameForOperation(operation),
      status: "APPLIED",
      claimIds: [],
      questionClarifications: operation.kind === "REQUEST_CLARIFICATION" ? [operation.clarification] : [],
      disclosureCodes: [],
      publicResult: {},
    }),
    publishReply: async (proposal: AssistantEnvelopeProposal) => ({
      outcome: proposal.outcome,
      addressedOpIds: committedPlan?.ops.map((operation) => operation.opId) ?? [],
      blocks: proposal.blocks.map((block) => {
        if (block.type === "TRANSITION") return { type: "TRANSITION" as const, text: block.transitionCode };
        if (block.type === "QUESTION") return { type: "QUESTION" as const, clarification: block.clarification, wording: block.clarification.kind };
        return block;
      }),
      nextMoves: [],
    }),
    fallbackReply: async (errorCode, plan) => ({
      outcome: "DEGRADED",
      addressedOpIds: plan?.ops.map((operation) => operation.opId) ?? ["unplanned"],
      blocks: [{ type: "TRANSITION", text: errorCode }],
      nextMoves: [],
    }),
  };
  return controller;
}

function operationReferents(operation: TurnOperation): CandidateReferent[] {
  if ("referents" in operation && Array.isArray(operation.referents)) return operation.referents;
  if ("referent" in operation && operation.referent) return [operation.referent];
  return [];
}

function resolvePlanReferents(plan: TurnPlan, initial: WorkingSet): Array<{ operationKind: string; offerRefs: string[] }> {
  let set = structuredClone(initial);
  const resolved: Array<{ operationKind: string; offerRefs: string[] }> = [];
  for (const operation of plan.ops) {
    let refs: string[] = [];
    if (operation.kind === "RESTORE_OFFERS" && set.rejectedOfferRefs.length === 1) refs = [...set.rejectedOfferRefs];
    else {
      const referents = operationReferents(operation);
      if (referents.length > 0) refs = resolveReferents(set, referents);
    }
    if (refs.length > 0) resolved.push({ operationKind: operation.kind, offerRefs: refs });
    if (operation.kind === "REJECT_OFFERS") set = rejectWorkingSetOffers(set, refs);
    else if (operation.kind === "RESTORE_OFFERS") set = restoreWorkingSetOffers(set, refs);
    else if (operation.kind === "SET_COMPARISON") set = setWorkingSetComparison(set, refs);
    else if (operation.kind === "SET_FOCUS") set = setWorkingSetFocus(set, refs[0] ?? null);
  }
  return resolved;
}

function referentScore(expected: ExpectedReferent[], actual: Array<{ operationKind: string; offerRefs: string[] }>): { correct: number; total: number } {
  let correct = 0;
  let total = 0;
  for (const item of expected) {
    total += item.offerRefs.length;
    const bound = new Set(actual
      .filter((candidate) => candidate.operationKind === item.operationKind)
      .flatMap((candidate) => candidate.offerRefs));
    correct += item.offerRefs.filter((offerRef) => bound.has(offerRef)).length;
  }
  return { correct, total };
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]!;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function effectiveInputTokens(trial: TrialResult): number {
  const usage = trial.modelUsage!;
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function metricSummary(trials: TrialResult[]) {
  const valid = trials.filter((trial) => trial.status === "VALID");
  const stateEligible = valid;
  const referentEligible = valid.filter((trial) => trial.referentTotal > 0);
  const stateCorrect = stateEligible.filter((trial) => trial.stateCorrect).length;
  const referentCorrect = referentEligible.reduce((sum, trial) => sum + trial.referentCorrect, 0);
  const referentTotal = referentEligible.reduce((sum, trial) => sum + trial.referentTotal, 0);
  const inputTokens = valid.map(effectiveInputTokens);
  const uncachedInputTokens = valid.map((trial) => trial.modelUsage!.inputTokens);
  return {
    validTrials: valid.length,
    invalidTrials: trials.length - valid.length,
    multiTurnConstraintState: { numerator: stateCorrect, denominator: stateEligible.length, value: ratio(stateCorrect, stateEligible.length) },
    candidateReferentAccuracy: { numerator: referentCorrect, denominator: referentTotal, value: ratio(referentCorrect, referentTotal) },
    inputTokens: {
      total: inputTokens.reduce((sum, value) => sum + value, 0),
      p50: percentile(inputTokens, 0.5),
      p95: percentile(inputTokens, 0.95),
      uncachedTotal: uncachedInputTokens.reduce((sum, value) => sum + value, 0),
    },
  };
}

function percentage(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report: JsonRecord): string {
  const metrics = record(report["metrics"], "report.metrics");
  const projected = record(metrics["projected"], "report.metrics.projected");
  const baseline = record(metrics["fullTranscriptBaseline"], "report.metrics.fullTranscriptBaseline");
  const token = record(metrics["tokenReduction"], "report.metrics.tokenReduction");
  const uncached = record(token["uncached"], "report.metrics.tokenReduction.uncached");
  const projectedState = record(projected["multiTurnConstraintState"], "projected.state");
  const projectedReferent = record(projected["candidateReferentAccuracy"], "projected.referent");
  const baselineState = record(baseline["multiTurnConstraintState"], "baseline.state");
  const baselineReferent = record(baseline["candidateReferentAccuracy"], "baseline.referent");
  return `# 上下文消融评测结果\n\n`
    + `> 评测级别：开发集。该结果用于验证 Harness 和发现问题，尚未经过独立 Gold 组卷，因此 \`${String(report["eligibleForResumeMetrics"])}\`，不能直接作为最终简历指标。\n\n`
    + `- 模型：\`${String(report["modelId"])}\`\n`
    + `- 用例：${String(report["caseCount"])} 个，每个策略重复 ${String(report["repeats"])} 次\n`
    + `- Token 口径：总有效输入按供应商 usage 的 \`input + cacheRead + cacheWrite\` 计算\n\n`
    + `| 指标 | 结构化投影 | 全量历史基线 |\n| --- | ---: | ---: |\n`
    + `| 多轮约束状态正确 | ${String(projectedState["numerator"])}/${String(projectedState["denominator"])}（${percentage(projectedState["value"] as number | null)}） | ${String(baselineState["numerator"])}/${String(baselineState["denominator"])}（${percentage(baselineState["value"] as number | null)}） |\n`
    + `| 候选指代正确 | ${String(projectedReferent["numerator"])}/${String(projectedReferent["denominator"])}（${percentage(projectedReferent["value"] as number | null)}） | ${String(baselineReferent["numerator"])}/${String(baselineReferent["denominator"])}（${percentage(baselineReferent["value"] as number | null)}） |\n`
    + `| 模型输入 Token | ${String(token["projectedInputTokens"])} | ${String(token["baselineInputTokens"])} |\n\n`
    + `总有效输入 Token 降幅：**${percentage(token["value"] as number | null)}**；未缓存输入从 ${String(uncached["baselineInputTokens"])} 降至 ${String(uncached["projectedInputTokens"])}，降幅 **${percentage(uncached["value"] as number | null)}**。\n\n`
    + `只有在独立评审者冻结用例与 Gold、两组运行均无系统性供应商失败，并保留原始 usage 和轨迹后，才能把结果升级为简历口径。\n`;
}

const specPath = resolve(process.env["INTEREC_CONTEXT_EVAL_SPEC"] ?? "spec/evaluation/context-ablation-v1/cases.json");
const outputPath = resolve(process.env["INTEREC_CONTEXT_EVAL_OUTPUT"] ?? ".artifacts/evaluation/context-ablation-v1.json");
const reportPath = resolve(process.env["INTEREC_CONTEXT_EVAL_REPORT"] ?? "docs/acceptance/context-ablation-development-result.md");
const specBytes = readFileSync(specPath);
const spec = parseSpec(JSON.parse(specBytes.toString("utf8")));
const selectedIds = new Set((process.env["INTEREC_CONTEXT_EVAL_CASE_IDS"] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const selectedCases = selectedIds.size > 0 ? spec.cases.filter((testCase) => selectedIds.has(testCase.caseId)) : spec.cases;
if (selectedCases.length === 0) throw new Error("CONTEXT_EVAL_NO_CASES_SELECTED");
const repeats = Number(process.env["INTEREC_CONTEXT_EVAL_REPEATS"] ?? spec.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("CONTEXT_EVAL_REPEATS_OVERRIDE_INVALID");
if (process.env["INTEREC_CONTEXT_EVAL_DRY_RUN"] === "1") {
  process.stdout.write(`${JSON.stringify({
    specPath,
    specSha256: `sha256:${createHash("sha256").update(specBytes).digest("hex")}`,
    selectedCaseIds: selectedCases.map((testCase) => testCase.caseId),
    repeats,
    plannedTrials: selectedCases.length * repeats * 2,
  }, null, 2)}\n`);
  process.exit(0);
}
const pi = createPiModelRuntime();
const startedAt = new Date().toISOString();
const trials: TrialResult[] = [];

for (let runIndex = 1; runIndex <= repeats; runIndex += 1) {
  for (const [caseIndex, testCase] of selectedCases.entries()) {
    const arms: Arm[] = (runIndex + caseIndex) % 2 === 0
      ? ["PROJECTED", "FULL_TRANSCRIPT"]
      : ["FULL_TRANSCRIPT", "PROJECTED"];
    for (const arm of arms) {
      const trialId = `${testCase.caseId}-run-${runIndex}-${arm.toLocaleLowerCase()}`;
      const state = initialState(testCase);
      const expected = expectedGoal(testCase);
      try {
        const result = await executeConversationTurn({
          model: pi.model,
          streamFn: pi.streamFn,
          apiKey: pi.apiKey,
          controller: controllerHarness(),
          context: {
            state,
            currentUserMessages: [testCase.currentUserMessage],
            ...(testCase.uiFocusOfferRef ? { uiFocusOfferRef: testCase.uiFocusOfferRef } : {}),
            recentAdjacentPair: spec.commonHistory.slice(-2),
            ...(arm === "FULL_TRANSCRIPT" ? { fullTranscript: spec.commonHistory } : {}),
            capabilities: ["conversation", "clarification", "goal", "working_set", "comparison", "search", "undo"],
            now: "2026-08-30T00:00:00.000Z",
            modelId: String(pi.model.id),
            providerCallBudget: 0,
            maxInputTokens: arm === "FULL_TRANSCRIPT" ? 64_000 : 8_000,
          },
          sessionId: trialId,
        });
        const goalOperations = (result.plan?.ops ?? []).filter((operation): operation is GoalOperation => operation.kind.startsWith("GOAL_"));
        const actualGoalValue = applyGoalOperations(baseGoal(), goalOperations);
        const actualReferents = result.plan && state.workingSet ? resolvePlanReferents(result.plan, state.workingSet) : [];
        const referents = referentScore(testCase.expectedReferents, actualReferents);
        const stateCorrect = canonical(publicGoal(actualGoalValue)) === canonical(publicGoal(expected));
        const usageValid = result.modelUsage.responses > 0
          && result.modelUsage.inputTokens + result.modelUsage.cacheReadTokens + result.modelUsage.cacheWriteTokens > 0;
        trials.push({
          trialId,
          caseId: testCase.caseId,
          runIndex,
          arm,
          status: usageValid ? "VALID" : "INVALID",
          failure: usageValid ? null : "MODEL_INPUT_USAGE_MISSING",
          stateCorrect,
          referentCorrect: referents.correct,
          referentTotal: referents.total,
          modelUsage: result.modelUsage,
          projectedContextEstimatedTokens: result.context.runtime.estimatedInputTokens,
          operationKinds: result.plan?.ops.map((operation) => operation.kind) ?? [],
          expectedGoal: publicGoal(expected),
          actualGoal: publicGoal(actualGoalValue),
          expectedReferents: testCase.expectedReferents,
          actualReferents,
        });
      } catch (error) {
        trials.push({
          trialId,
          caseId: testCase.caseId,
          runIndex,
          arm,
          status: "INVALID",
          failure: error instanceof Error ? error.message : "UNKNOWN",
          stateCorrect: false,
          referentCorrect: 0,
          referentTotal: testCase.expectedReferents.reduce((sum, item) => sum + item.offerRefs.length, 0),
          modelUsage: null,
          projectedContextEstimatedTokens: null,
          operationKinds: [],
          expectedGoal: publicGoal(expected),
          actualGoal: null,
          expectedReferents: testCase.expectedReferents,
          actualReferents: [],
        });
      }
      process.stdout.write(`${JSON.stringify({ trialId, status: trials.at(-1)!.status, failure: trials.at(-1)!.failure })}\n`);
    }
  }
}

const projectedTrials = trials.filter((trial) => trial.arm === "PROJECTED");
const baselineTrials = trials.filter((trial) => trial.arm === "FULL_TRANSCRIPT");
const projected = metricSummary(projectedTrials);
const baseline = metricSummary(baselineTrials);
const pairedKeys = new Set(projectedTrials.filter((trial) => trial.status === "VALID").map((trial) => `${trial.caseId}:${trial.runIndex}`));
const validPairKeys = [...pairedKeys].filter((key) => baselineTrials.some((trial) => `${trial.caseId}:${trial.runIndex}` === key && trial.status === "VALID"));
const sumForPairs = (values: TrialResult[], measure: (trial: TrialResult) => number) => values
  .filter((trial) => validPairKeys.includes(`${trial.caseId}:${trial.runIndex}`))
  .reduce((sum, trial) => sum + measure(trial), 0);
const projectedInputTokens = sumForPairs(projectedTrials, effectiveInputTokens);
const baselineInputTokens = sumForPairs(baselineTrials, effectiveInputTokens);
const projectedUncachedInputTokens = sumForPairs(projectedTrials, (trial) => trial.modelUsage!.inputTokens);
const baselineUncachedInputTokens = sumForPairs(baselineTrials, (trial) => trial.modelUsage!.inputTokens);
const reduction = baselineInputTokens > 0 ? (baselineInputTokens - projectedInputTokens) / baselineInputTokens : null;
const report: JsonRecord = {
  schemaVersion: "interec-context-ablation-report-v1",
  evaluationScope: spec.evaluationScope,
  eligibleForResumeMetrics: false,
  specPath,
  specSha256: `sha256:${createHash("sha256").update(specBytes).digest("hex")}`,
  modelId: String(pi.model.id),
  caseCount: selectedCases.length,
  repeats,
  startedAt,
  completedAt: new Date().toISOString(),
  metrics: {
    projected,
    fullTranscriptBaseline: baseline,
    tokenReduction: {
      pairedTrials: validPairKeys.length,
      projectedInputTokens,
      baselineInputTokens,
      value: reduction,
      uncached: {
        projectedInputTokens: projectedUncachedInputTokens,
        baselineInputTokens: baselineUncachedInputTokens,
        value: baselineUncachedInputTokens > 0
          ? (baselineUncachedInputTokens - projectedUncachedInputTokens) / baselineUncachedInputTokens
          : null,
      },
    },
  },
  trials,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, markdownReport(report), "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, reportPath, metrics: report["metrics"] }, null, 2)}\n`);
if (projected.invalidTrials > 0 || baseline.invalidTrials > 0) process.exitCode = 1;
