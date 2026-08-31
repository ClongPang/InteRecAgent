import type {
  DevelopmentGoalExpectation,
  DevelopmentTurnExpectation,
} from "./development-evaluation-cases.js";

type JsonRecord = Record<string, unknown>;

export interface DevelopmentBehaviorAssertionResult {
  passed: boolean;
  failures: string[];
  checkedTurnCount: number;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value);
  if (item) return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function goalFromTurn(turn: JsonRecord): JsonRecord | null {
  return record(record(turn["draft_goal_json"])?.["goal"]);
}

function pushMismatch(failures: string[], turnIndex: number, field: string, expected: unknown, observed: unknown): void {
  failures.push(`turn_${turnIndex}:${field}:expected=${canonical(expected)}:observed=${canonical(observed)}`);
}

function checkGoalExpectation(
  failures: string[],
  turnIndex: number,
  expected: DevelopmentGoalExpectation,
  observed: JsonRecord | null,
): void {
  if (!observed) {
    failures.push(`turn_${turnIndex}:goal:missing`);
    return;
  }
  if (Object.hasOwn(expected, "target")) {
    const actualTarget = record(observed["target"]);
    if (expected.target === null) {
      if (observed["target"] !== null) pushMismatch(failures, turnIndex, "goal.target", null, observed["target"]);
    } else if (!actualTarget) {
      pushMismatch(failures, turnIndex, "goal.target", expected.target, observed["target"]);
    } else {
      for (const [key, value] of Object.entries(expected.target ?? {})) {
        if (canonical(actualTarget[key]) !== canonical(value)) pushMismatch(failures, turnIndex, `goal.target.${key}`, value, actualTarget[key]);
      }
    }
  }
  if (Object.hasOwn(expected, "budget")) {
    const actualBudget = record(observed["budget"]);
    if (expected.budget === null) {
      if (observed["budget"] !== null) pushMismatch(failures, turnIndex, "goal.budget", null, observed["budget"]);
    } else if (!actualBudget) {
      pushMismatch(failures, turnIndex, "goal.budget", expected.budget, observed["budget"]);
    } else {
      if (actualBudget["amount"] !== expected.budget?.amount) pushMismatch(failures, turnIndex, "goal.budget.amount", expected.budget?.amount, actualBudget["amount"]);
      if (String(actualBudget["currency"] ?? "").toUpperCase() !== expected.budget?.currency) pushMismatch(failures, turnIndex, "goal.budget.currency", expected.budget?.currency, actualBudget["currency"]);
    }
  }
  if (expected.retrievalMarkets) {
    const actual = array(observed["retrievalMarkets"]).map(String).map((market) => market.toUpperCase()).sort();
    if (canonical(actual) !== canonical(expected.retrievalMarkets)) pushMismatch(failures, turnIndex, "goal.retrievalMarkets", expected.retrievalMarkets, actual);
  }
  if (expected.preferenceKeys) {
    const actual = array(observed["preferences"]).flatMap((value) => {
      const item = record(value);
      return typeof item?.["key"] === "string" ? [item["key"]] : [];
    }).sort();
    if (canonical(actual) !== canonical(expected.preferenceKeys)) pushMismatch(failures, turnIndex, "goal.preferenceKeys", expected.preferenceKeys, actual);
  }
  if (expected.hardConstraintKeys) {
    const actual = array(observed["hardConstraints"]).flatMap((value) => {
      const item = record(value);
      return typeof item?.["key"] === "string" ? [item["key"]] : [];
    }).sort();
    if (canonical(actual) !== canonical(expected.hardConstraintKeys)) pushMismatch(failures, turnIndex, "goal.hardConstraintKeys", expected.hardConstraintKeys, actual);
  }
}

function checkPreservedGoalFields(
  failures: string[],
  turnIndex: number,
  expectation: DevelopmentTurnExpectation,
  previousGoal: JsonRecord | null,
  currentGoal: JsonRecord | null,
): void {
  for (const field of expectation.preservedGoalFields ?? []) {
    const key = field === "TARGET"
      ? "target"
      : field === "BUDGET"
        ? "budget"
        : field === "RETRIEVAL_MARKETS"
          ? "retrievalMarkets"
          : field === "PREFERENCES"
            ? "preferences"
            : "hardConstraints";
    const preservesCollection = field === "PREFERENCES" || field === "HARD_CONSTRAINTS";
    const previousItems = array(previousGoal?.[key]);
    const currentItemKeys = new Set(array(currentGoal?.[key]).map(canonical));
    const preserved = preservesCollection
      ? Boolean(previousGoal && currentGoal) && previousItems.every((item) => currentItemKeys.has(canonical(item)))
      : Boolean(previousGoal && currentGoal) && canonical(previousGoal?.[key]) === canonical(currentGoal?.[key]);
    if (!preserved) {
      pushMismatch(failures, turnIndex, `preserved.${field}`, previousGoal?.[key], currentGoal?.[key]);
    }
  }
}

function checkPlanReview(
  failures: string[],
  turnIndex: number,
  expectation: NonNullable<DevelopmentTurnExpectation["planReview"]>,
  turn: JsonRecord,
): void {
  const reviews = array(turn["planReviews"]).map(record).filter((value): value is JsonRecord => value !== null);
  const decisions = reviews.map((review) => String(review["decision"] ?? ""));
  if (reviews.length === 0) failures.push(`turn_${turnIndex}:planReview:missing`);
  if (reviews.length > expectation.maxProposals) pushMismatch(failures, turnIndex, "planReview.proposalCount.max", expectation.maxProposals, reviews.length);
  for (const decision of decisions) {
    if (!expectation.allowedDecisions.includes(decision as never)) pushMismatch(failures, turnIndex, "planReview.allowedDecision", expectation.allowedDecisions, decision);
  }
  const terminal = decisions.at(-1) ?? null;
  if (terminal !== expectation.terminalDecision) pushMismatch(failures, turnIndex, "planReview.terminalDecision", expectation.terminalDecision, terminal);
  if (decisions.includes("REPAIR_REQUIRED") && expectation.requiredRepairViolationCodes) {
    const actualCodes = new Set(reviews.flatMap((review) => array(review["violations_json"]).flatMap((violation) => {
      const item = record(violation);
      return typeof item?.["code"] === "string" ? [item["code"]] : [];
    })));
    for (const code of expectation.requiredRepairViolationCodes) {
      if (!actualCodes.has(code)) failures.push(`turn_${turnIndex}:planReview.requiredRepairViolationCode:missing=${code}`);
    }
  }
}

export function evaluateDevelopmentBehaviorAssertions(
  expectations: DevelopmentTurnExpectation[] | undefined,
  turnEvidence: unknown[],
): DevelopmentBehaviorAssertionResult {
  if (!expectations) return { passed: true, failures: [], checkedTurnCount: 0 };
  const failures: string[] = [];
  for (const [offset, expectation] of expectations.entries()) {
    const turnIndex = offset + 1;
    const turn = record(turnEvidence[offset]);
    if (!turn) {
      failures.push(`turn_${turnIndex}:evidence:missing`);
      continue;
    }
    const goal = goalFromTurn(turn);
    if (expectation.goal) checkGoalExpectation(failures, turnIndex, expectation.goal, goal);
    checkPreservedGoalFields(failures, turnIndex, expectation, offset > 0 ? goalFromTurn(record(turnEvidence[offset - 1]) ?? {}) : null, goal);
    const dialogue = record(turn["draft_dialogue_json"]);
    const pending = record(dialogue?.["pendingClarification"]);
    if (Object.hasOwn(expectation, "pendingClarification") && Boolean(pending) !== expectation.pendingClarification) {
      pushMismatch(failures, turnIndex, "pendingClarification", expectation.pendingClarification, Boolean(pending));
    }
    if (Object.hasOwn(expectation, "clarificationKind")) {
      const actualKind = record(pending?.["clarification"])?.["kind"] ?? null;
      if (actualKind !== expectation.clarificationKind) pushMismatch(failures, turnIndex, "clarificationKind", expectation.clarificationKind, actualKind);
    }
    if (expectation.allowedOutcomes && !expectation.allowedOutcomes.includes(String(turn["outcome"] ?? ""))) {
      pushMismatch(failures, turnIndex, "allowedOutcomes", expectation.allowedOutcomes, turn["outcome"]);
    }
    if (expectation.productSearchCalls) {
      const calls = array(turn["search"]).length;
      if (calls < expectation.productSearchCalls.min || calls > expectation.productSearchCalls.max) {
        pushMismatch(failures, turnIndex, "productSearchCalls", expectation.productSearchCalls, calls);
      }
    }
    if (expectation.planReview) checkPlanReview(failures, turnIndex, expectation.planReview, turn);
  }
  return { passed: failures.length === 0, failures, checkedTurnCount: expectations.length };
}
