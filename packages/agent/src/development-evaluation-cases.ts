import type { EvaluationAuthoringPlan } from "./evaluation-authoring-plan.js";

export const EVALUATION_FIXTURE_SEEDS = [
  "HEADPHONES_XM5",
  "HEADPHONES_XM4",
  "SMARTPHONE_IPHONE16PRO_256",
  "SMARTPHONE_PIXEL9PRO_256",
  "OPEN_WASHER",
  "OPEN_OFFICE_CHAIR",
  "OPEN_TO_HEADPHONES",
  "HEADPHONES_ACCESSORY_TRAPS",
] as const;

export const EVALUATION_PRESERVED_GOAL_FIELDS = [
  "TARGET",
  "BUDGET",
  "RETRIEVAL_MARKETS",
  "PREFERENCES",
  "HARD_CONSTRAINTS",
] as const;

export const EVALUATION_PLAN_REVIEW_DECISIONS = [
  "APPROVED",
  "REPAIR_REQUIRED",
  "REJECTED",
] as const;

const EVALUATION_ITEM_ROLES = ["PRIMARY_PRODUCT", "ACCESSORY", "REPLACEMENT_PART", "BUNDLE", "SERVICE"] as const;
const EVALUATION_TARGET_CONDITIONS = ["NEW", "USED", "REFURBISHED", "ANY"] as const;

export interface DevelopmentTargetExpectation {
  categoryId?: string;
  targetText?: string;
  canonicalModel?: string | null;
  itemRole?: "PRIMARY_PRODUCT" | "ACCESSORY" | "REPLACEMENT_PART" | "BUNDLE" | "SERVICE";
  condition?: "NEW" | "USED" | "REFURBISHED" | "ANY";
}

export interface DevelopmentBudgetExpectation {
  amount: string;
  currency: string;
}

export interface DevelopmentGoalExpectation {
  target?: DevelopmentTargetExpectation | null;
  budget?: DevelopmentBudgetExpectation | null;
  retrievalMarkets?: string[];
  preferenceKeys?: string[];
  hardConstraintKeys?: string[];
}

export interface DevelopmentPlanReviewExpectation {
  terminalDecision: typeof EVALUATION_PLAN_REVIEW_DECISIONS[number];
  maxProposals: number;
  allowedDecisions: Array<typeof EVALUATION_PLAN_REVIEW_DECISIONS[number]>;
  requiredRepairViolationCodes?: string[];
}

export interface DevelopmentTurnExpectation {
  goal?: DevelopmentGoalExpectation;
  preservedGoalFields?: Array<typeof EVALUATION_PRESERVED_GOAL_FIELDS[number]>;
  clarificationKind?: string | null;
  pendingClarification?: boolean;
  allowedOutcomes?: string[];
  productSearchCalls?: { min: number; max: number };
  planReview?: DevelopmentPlanReviewExpectation;
}

export interface DevelopmentEvaluationCase {
  taskId: string;
  fixtureSeed: typeof EVALUATION_FIXTURE_SEEDS[number];
  environmentAction: string;
  focusDisplayRank?: number;
  userTurns: string[];
  turnExpectations?: DevelopmentTurnExpectation[];
}

export interface DevelopmentEvaluationCases {
  schemaVersion: "interec-development-evaluation-cases-v1";
  evaluationScope: "DEVELOPMENT_EVALUATION";
  eligibleForResumeMetrics: false;
  planVersion: string;
  planSemanticSha256: string;
  cases: DevelopmentEvaluationCase[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, optionalKeys: readonly string[] = []): void {
  const allowed = new Set([...keys, ...optionalKeys]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`DEVELOPMENT_EVAL_FIELD_UNKNOWN:${path}.${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`DEVELOPMENT_EVAL_FIELD_MISSING:${path}.${key}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}`);
  return value.trim();
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}`);
  return Number(value);
}

function uniqueTexts(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}`);
  }
  const result = value.map((item) => String(item).trim());
  if (new Set(result).size !== result.length) throw new Error(`DEVELOPMENT_EVAL_FIELD_DUPLICATE:${path}`);
  return result;
}

function parseGoalExpectation(value: unknown, path: string): DevelopmentGoalExpectation {
  const entry = record(value, path);
  exactKeys(entry, [], path, ["target", "budget", "retrievalMarkets", "preferenceKeys", "hardConstraintKeys"]);
  const result: DevelopmentGoalExpectation = {};
  if (Object.hasOwn(entry, "target")) {
    if (entry["target"] === null) result.target = null;
    else {
      const target = record(entry["target"], `${path}.target`);
      exactKeys(target, [], `${path}.target`, ["categoryId", "targetText", "canonicalModel", "itemRole", "condition"]);
      if (Object.keys(target).length === 0) throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}.target`);
      const itemRole = Object.hasOwn(target, "itemRole") ? text(target["itemRole"], `${path}.target.itemRole`) : undefined;
      const condition = Object.hasOwn(target, "condition") ? text(target["condition"], `${path}.target.condition`) : undefined;
      if (itemRole && !(EVALUATION_ITEM_ROLES as readonly string[]).includes(itemRole)) throw new Error(`DEVELOPMENT_EVAL_TARGET_ROLE_INVALID:${path}`);
      if (condition && !(EVALUATION_TARGET_CONDITIONS as readonly string[]).includes(condition)) throw new Error(`DEVELOPMENT_EVAL_TARGET_CONDITION_INVALID:${path}`);
      result.target = {
        ...(Object.hasOwn(target, "categoryId") ? { categoryId: text(target["categoryId"], `${path}.target.categoryId`) } : {}),
        ...(Object.hasOwn(target, "targetText") ? { targetText: text(target["targetText"], `${path}.target.targetText`) } : {}),
        ...(Object.hasOwn(target, "canonicalModel") ? {
          canonicalModel: target["canonicalModel"] === null ? null : text(target["canonicalModel"], `${path}.target.canonicalModel`),
        } : {}),
        ...(itemRole ? { itemRole: itemRole as NonNullable<DevelopmentTargetExpectation["itemRole"]> } : {}),
        ...(condition ? { condition: condition as NonNullable<DevelopmentTargetExpectation["condition"]> } : {}),
      };
    }
  }
  if (Object.hasOwn(entry, "budget")) {
    if (entry["budget"] === null) result.budget = null;
    else {
      const budget = record(entry["budget"], `${path}.budget`);
      exactKeys(budget, ["amount", "currency"], `${path}.budget`);
      result.budget = {
        amount: text(budget["amount"], `${path}.budget.amount`),
        currency: text(budget["currency"], `${path}.budget.currency`).toUpperCase(),
      };
    }
  }
  if (Object.hasOwn(entry, "retrievalMarkets")) result.retrievalMarkets = uniqueTexts(entry["retrievalMarkets"], `${path}.retrievalMarkets`, true).map((market) => market.toUpperCase()).sort();
  if (Object.hasOwn(entry, "preferenceKeys")) result.preferenceKeys = uniqueTexts(entry["preferenceKeys"], `${path}.preferenceKeys`, true).sort();
  if (Object.hasOwn(entry, "hardConstraintKeys")) result.hardConstraintKeys = uniqueTexts(entry["hardConstraintKeys"], `${path}.hardConstraintKeys`, true).sort();
  return result;
}

function parseTurnExpectation(value: unknown, path: string): DevelopmentTurnExpectation {
  const entry = record(value, path);
  exactKeys(entry, [], path, ["goal", "preservedGoalFields", "clarificationKind", "pendingClarification", "allowedOutcomes", "productSearchCalls", "planReview"]);
  const result: DevelopmentTurnExpectation = {};
  if (Object.hasOwn(entry, "goal")) result.goal = parseGoalExpectation(entry["goal"], `${path}.goal`);
  if (Object.hasOwn(entry, "preservedGoalFields")) {
    const fields = uniqueTexts(entry["preservedGoalFields"], `${path}.preservedGoalFields`);
    if (fields.some((field) => !(EVALUATION_PRESERVED_GOAL_FIELDS as readonly string[]).includes(field))) throw new Error(`DEVELOPMENT_EVAL_PRESERVED_FIELD_INVALID:${path}`);
    result.preservedGoalFields = fields as NonNullable<DevelopmentTurnExpectation["preservedGoalFields"]>;
  }
  if (Object.hasOwn(entry, "clarificationKind")) result.clarificationKind = entry["clarificationKind"] === null ? null : text(entry["clarificationKind"], `${path}.clarificationKind`);
  if (Object.hasOwn(entry, "pendingClarification")) {
    if (typeof entry["pendingClarification"] !== "boolean") throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}.pendingClarification`);
    result.pendingClarification = entry["pendingClarification"];
  }
  if (Object.hasOwn(entry, "allowedOutcomes")) result.allowedOutcomes = uniqueTexts(entry["allowedOutcomes"], `${path}.allowedOutcomes`);
  if (Object.hasOwn(entry, "productSearchCalls")) {
    const calls = record(entry["productSearchCalls"], `${path}.productSearchCalls`);
    exactKeys(calls, ["min", "max"], `${path}.productSearchCalls`);
    const min = integer(calls["min"], `${path}.productSearchCalls.min`);
    const max = integer(calls["max"], `${path}.productSearchCalls.max`);
    if (max < min) throw new Error(`DEVELOPMENT_EVAL_PROVIDER_BUDGET_INVALID:${path}`);
    result.productSearchCalls = { min, max };
  }
  if (Object.hasOwn(entry, "planReview")) {
    const review = record(entry["planReview"], `${path}.planReview`);
    exactKeys(review, ["terminalDecision", "maxProposals", "allowedDecisions"], `${path}.planReview`, ["requiredRepairViolationCodes"]);
    const terminalDecision = text(review["terminalDecision"], `${path}.planReview.terminalDecision`);
    const allowedDecisions = uniqueTexts(review["allowedDecisions"], `${path}.planReview.allowedDecisions`);
    if (!(EVALUATION_PLAN_REVIEW_DECISIONS as readonly string[]).includes(terminalDecision)
      || allowedDecisions.some((decision) => !(EVALUATION_PLAN_REVIEW_DECISIONS as readonly string[]).includes(decision))) {
      throw new Error(`DEVELOPMENT_EVAL_PLAN_REVIEW_DECISION_INVALID:${path}`);
    }
    result.planReview = {
      terminalDecision: terminalDecision as DevelopmentPlanReviewExpectation["terminalDecision"],
      maxProposals: integer(review["maxProposals"], `${path}.planReview.maxProposals`),
      allowedDecisions: allowedDecisions as DevelopmentPlanReviewExpectation["allowedDecisions"],
      ...(Object.hasOwn(review, "requiredRepairViolationCodes") ? {
        requiredRepairViolationCodes: uniqueTexts(review["requiredRepairViolationCodes"], `${path}.planReview.requiredRepairViolationCodes`),
      } : {}),
    };
  }
  if (Object.keys(result).length === 0) throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}`);
  return result;
}

export function parseDevelopmentEvaluationCases(value: unknown): DevelopmentEvaluationCases {
  const item = record(value, "developmentEvaluationCases");
  exactKeys(item, ["schemaVersion", "evaluationScope", "eligibleForResumeMetrics", "planVersion", "planSemanticSha256", "cases"], "developmentEvaluationCases");
  if (item["schemaVersion"] !== "interec-development-evaluation-cases-v1") throw new Error("DEVELOPMENT_EVAL_SCHEMA_INVALID");
  if (item["evaluationScope"] !== "DEVELOPMENT_EVALUATION") throw new Error("DEVELOPMENT_EVALUATION_SCOPE_INVALID");
  if (item["eligibleForResumeMetrics"] !== false) throw new Error("DEVELOPMENT_EVAL_CANNOT_AUTHORIZE_RESUME_METRICS");
  if (!Array.isArray(item["cases"])) throw new Error("DEVELOPMENT_EVAL_CASES_INVALID");
  const cases = item["cases"].map((value, index): DevelopmentEvaluationCase => {
    const path = `developmentEvaluationCases.cases.${index}`;
    const entry = record(value, path);
    exactKeys(entry, ["taskId", "fixtureSeed", "environmentAction", "userTurns"], path, ["focusDisplayRank", "turnExpectations"]);
    const fixtureSeed = text(entry["fixtureSeed"], `${path}.fixtureSeed`);
    if (!(EVALUATION_FIXTURE_SEEDS as readonly string[]).includes(fixtureSeed)) throw new Error(`DEVELOPMENT_EVAL_FIXTURE_SEED_INVALID:${fixtureSeed}`);
    if (!Array.isArray(entry["userTurns"]) || entry["userTurns"].length < 2 || entry["userTurns"].length > 4) throw new Error(`DEVELOPMENT_EVAL_TURNS_INVALID:${path}`);
    const focusDisplayRank = entry["focusDisplayRank"];
    if (focusDisplayRank !== undefined && (!Number.isSafeInteger(focusDisplayRank) || Number(focusDisplayRank) < 1 || Number(focusDisplayRank) > 20)) {
      throw new Error(`DEVELOPMENT_EVAL_FOCUS_RANK_INVALID:${path}`);
    }
    return {
      taskId: text(entry["taskId"], `${path}.taskId`),
      fixtureSeed: fixtureSeed as DevelopmentEvaluationCase["fixtureSeed"],
      environmentAction: text(entry["environmentAction"], `${path}.environmentAction`),
      ...(focusDisplayRank === undefined ? {} : { focusDisplayRank: Number(focusDisplayRank) }),
      userTurns: entry["userTurns"].map((turn, turnIndex) => text(turn, `${path}.userTurns.${turnIndex}`)),
      ...(entry["turnExpectations"] === undefined ? {} : {
        turnExpectations: Array.isArray(entry["turnExpectations"])
          ? entry["turnExpectations"].map((expectation, turnIndex) => parseTurnExpectation(expectation, `${path}.turnExpectations.${turnIndex}`))
          : (() => { throw new Error(`DEVELOPMENT_EVAL_FIELD_INVALID:${path}.turnExpectations`); })(),
      }),
    };
  });
  return {
    schemaVersion: "interec-development-evaluation-cases-v1",
    evaluationScope: "DEVELOPMENT_EVALUATION",
    eligibleForResumeMetrics: false,
    planVersion: text(item["planVersion"], "developmentEvaluationCases.planVersion"),
    planSemanticSha256: text(item["planSemanticSha256"], "developmentEvaluationCases.planSemanticSha256"),
    cases,
  };
}

const META_LANGUAGE = /\b(?:offerRef|provider|working[ _-]?set|gold|fixture|harness|turn)\b|评测器|评分器|测试夹具|候选引用/iu;

export function validateDevelopmentEvaluationCases(input: DevelopmentEvaluationCases, plan: EvaluationAuthoringPlan, semanticSha256: string): void {
  if (input.planVersion !== plan.planVersion) throw new Error("DEVELOPMENT_EVAL_EVALUATION_PLAN_VERSION_MISMATCH");
  if (input.planSemanticSha256 !== semanticSha256) throw new Error("DEVELOPMENT_EVAL_EVALUATION_PLAN_HASH_MISMATCH");
  if (input.cases.length !== plan.tasks.length) throw new Error(`DEVELOPMENT_EVAL_CASE_COUNT:${input.cases.length}/${plan.tasks.length}`);
  const ids = new Set<string>();
  const allMessages = new Set<string>();
  for (const testCase of input.cases) {
    if (ids.has(testCase.taskId)) throw new Error(`DEVELOPMENT_EVAL_CASE_DUPLICATE:${testCase.taskId}`);
    ids.add(testCase.taskId);
    const task = plan.tasks.find((candidate) => candidate.taskId === testCase.taskId);
    if (!task) throw new Error(`DEVELOPMENT_EVAL_TASK_UNKNOWN:${testCase.taskId}`);
    if (testCase.environmentAction !== task.variationProfile.environmentAction) throw new Error(`DEVELOPMENT_EVAL_ENVIRONMENT_MISMATCH:${testCase.taskId}`);
    if (testCase.userTurns.length !== task.turns.length) throw new Error(`DEVELOPMENT_EVAL_TURN_COUNT:${testCase.taskId}:${testCase.userTurns.length}/${task.turns.length}`);
    if (testCase.turnExpectations && testCase.turnExpectations.length !== testCase.userTurns.length) {
      throw new Error(`DEVELOPMENT_EVAL_EXPECTATION_COUNT:${testCase.taskId}:${testCase.turnExpectations.length}/${testCase.userTurns.length}`);
    }
    if (testCase.turnExpectations?.[0]?.preservedGoalFields?.length) throw new Error(`DEVELOPMENT_EVAL_FIRST_TURN_CANNOT_PRESERVE:${testCase.taskId}`);
    for (const message of testCase.userTurns) {
      if (message.length > 300) throw new Error(`DEVELOPMENT_EVAL_MESSAGE_TOO_LONG:${testCase.taskId}`);
      if (META_LANGUAGE.test(message)) throw new Error(`DEVELOPMENT_EVAL_META_LANGUAGE:${testCase.taskId}`);
      const normalized = message.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
      if (allMessages.has(normalized)) throw new Error(`DEVELOPMENT_EVAL_MESSAGE_DUPLICATE:${testCase.taskId}`);
      allMessages.add(normalized);
    }
  }
  for (const task of plan.tasks) if (!ids.has(task.taskId)) throw new Error(`DEVELOPMENT_EVAL_TASK_MISSING:${task.taskId}`);
}
