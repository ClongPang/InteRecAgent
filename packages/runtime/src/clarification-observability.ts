import type { ClarificationIntent, ShoppingGoal } from "@interec/domain";

export type ClarificationResolutionOutcome = "RESOLVED" | "RESOLVED_WITH_NEXT_CLARIFICATION" | "REPEATED" | "DEGRADED";
export type RetainedGoalField = "TARGET" | "BUDGET" | "RETRIEVAL_MARKETS";

export interface GoalRetentionCheck {
  field: RetainedGoalField;
  retained: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function clarificationResolutionOutcome(
  answeredKind: ClarificationIntent["kind"],
  pendingKind: ClarificationIntent["kind"] | null,
  degraded: boolean,
): ClarificationResolutionOutcome {
  if (degraded) return "DEGRADED";
  if (pendingKind === answeredKind) return "REPEATED";
  if (pendingKind) return "RESOLVED_WITH_NEXT_CLARIFICATION";
  return "RESOLVED";
}

export function goalRetentionChecks(
  before: ShoppingGoal | null,
  after: ShoppingGoal | null,
  clarificationKind: ClarificationIntent["kind"],
): GoalRetentionCheck[] {
  if (!before) return [];
  return [
    ...((clarificationKind !== "TARGET_PRODUCT" && clarificationKind !== "TARGET_MODEL" && before.target)
      ? [{ field: "TARGET" as const, retained: canonical(before.target) === canonical(after?.target) }] : []),
    ...(clarificationKind !== "BUDGET" && before.budget
      ? [{ field: "BUDGET" as const, retained: canonical(before.budget) === canonical(after?.budget) }] : []),
    ...(clarificationKind !== "PURCHASE_MARKET" && before.retrievalMarkets.length > 0
      ? [{ field: "RETRIEVAL_MARKETS" as const, retained: canonical(before.retrievalMarkets) === canonical(after?.retrievalMarkets) }] : []),
  ];
}
