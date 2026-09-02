import { catalogIdentityCode } from "./turn-decision-provenance.js";
import type { TurnDecisionProvenance } from "./turn-decision-provenance.js";

export interface QuoteDecisionExpectation {
  route?: string | null;
  outcome?: string;
  operationKinds?: readonly string[];
  hasTarget?: boolean;
  hasPendingConfirmation?: boolean;
  leadOutcome?: string | null;
  targetLifecycle?: string;
  modelKey?: string | null;
  canonicalModel?: string | null;
}

export interface QuoteDecisionScore {
  name: string;
  value: number;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Deterministic code evaluator. Same mapper the trajectory script already uses.
 * This is the eval API; Langfuse product scores are an optional export of these values.
 */
export function scoreQuoteTurnDecision(
  actual: TurnDecisionProvenance,
  expected: QuoteDecisionExpectation,
): QuoteDecisionScore[] {
  const scores: QuoteDecisionScore[] = [];
  const add = (name: string, ok: boolean) => {
    scores.push({ name, value: ok ? 1 : 0 });
  };
  if (expected.route !== undefined) add("route", actual.route === expected.route);
  if (expected.outcome !== undefined) add("outcome", actual.outcome === expected.outcome);
  if (expected.operationKinds) add("operationKinds", sameJson(actual.operationKinds, expected.operationKinds));
  if (expected.hasTarget !== undefined) add("hasTarget", actual.after.hasTarget === expected.hasTarget);
  if (expected.hasPendingConfirmation !== undefined) {
    add("hasPendingConfirmation", actual.after.hasPendingConfirmation === expected.hasPendingConfirmation);
  }
  if (expected.leadOutcome !== undefined) add("leadOutcome", actual.after.leadOutcome === expected.leadOutcome);
  if (expected.targetLifecycle !== undefined) add("targetLifecycle", actual.targetLifecycle === expected.targetLifecycle);
  if (expected.modelKey !== undefined) add("modelKey", actual.after.modelKey === catalogIdentityCode(expected.modelKey));
  if (expected.canonicalModel !== undefined) {
    add("canonicalModel", actual.after.canonicalModel === catalogIdentityCode(expected.canonicalModel));
  }
  return scores;
}
