import type { ConversationState } from "@interec/domain";

import type { ProposedTurnOperation, TurnPlanProposal } from "./protocol.js";

function mutationKey(operation: ProposedTurnOperation): string | null {
  switch (operation.kind) {
    case "GOAL_SET_TARGET":
    case "GOAL_CLEAR_TARGET": return "goal:target";
    case "GOAL_SET_BUDGET":
    case "GOAL_CLEAR_BUDGET": return "goal:budget";
    case "GOAL_SET_RETRIEVAL_MARKETS": return "goal:retrieval_markets";
    case "GOAL_SET_DELIVERY_DESTINATION": return "goal:delivery_destination";
    case "GOAL_SET_STOCK_PREFERENCE": return "goal:stock_preference";
    case "GOAL_UPSERT_CONSTRAINT": return `constraint:${operation.constraint.key}`;
    case "GOAL_REMOVE_CONSTRAINT": return `constraint:${operation.key}`;
    case "GOAL_UPSERT_PREFERENCE": return `preference:${operation.preference.key}`;
    case "GOAL_REMOVE_PREFERENCE": return `preference:${operation.key}`;
    default: return null;
  }
}

function sourceOrdinal(operation: ProposedTurnOperation): number {
  return "sourceMessageOrdinal" in operation && typeof operation.sourceMessageOrdinal === "number"
    ? operation.sourceMessageOrdinal
    : -1;
}

function keepLatestMutations(operations: ProposedTurnOperation[]): ProposedTurnOperation[] {
  const winnerByKey = new Map<string, { index: number; ordinal: number }>();
  operations.forEach((operation, index) => {
    const key = mutationKey(operation);
    if (!key) return;
    const candidate = { index, ordinal: sourceOrdinal(operation) };
    const current = winnerByKey.get(key);
    if (!current || candidate.ordinal > current.ordinal || (candidate.ordinal === current.ordinal && candidate.index > current.index)) {
      winnerByKey.set(key, candidate);
    }
  });
  return operations.filter((operation, index) => {
    const key = mutationKey(operation);
    return !key || winnerByKey.get(key)?.index === index;
  });
}

function uniqueOpId(base: string, operations: ProposedTurnOperation[]): string {
  if (!operations.some((operation) => operation.opId === base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!operations.some((operation) => operation.opId === candidate)) return candidate;
  }
}

function derivesPriceOrder(key: string): boolean {
  const normalized = key.normalize("NFKC").toLocaleLowerCase("en-US");
  return normalized === "price" || normalized.endsWith("_price") || normalized.startsWith("price_");
}

function removeRedundantExploratoryMarketScope(
  operations: ProposedTurnOperation[],
  state: ConversationState,
): ProposedTurnOperation[] {
  const hasExplicitMarkets = Boolean(state.goalRevision?.goal.retrievalMarkets.length)
    || operations.some((operation) => operation.kind === "GOAL_SET_RETRIEVAL_MARKETS" && operation.markets.length > 0);
  if (!hasExplicitMarkets) return operations;
  return operations.map((operation) => {
    if (operation.kind !== "SEARCH_OFFERS" || !operation.marketScope) return operation;
    const {
      marketScope: _marketScope,
      assumptionDisclosureCodes: rawDisclosures,
      ...search
    } = operation;
    const assumptionDisclosureCodes = rawDisclosures?.filter((code) => code !== "PURCHASE_MARKET_SCOPE_ASSUMED");
    return {
      ...search,
      ...(assumptionDisclosureCodes?.length ? { assumptionDisclosureCodes } : {}),
    };
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function removeNoopCollectionUpserts(
  operations: ProposedTurnOperation[],
  state: ConversationState,
): ProposedTurnOperation[] {
  const goal = state.goalRevision?.goal;
  if (!goal) return operations;
  return operations.filter((operation) => {
    if (operation.kind === "GOAL_UPSERT_PREFERENCE") {
      const existing = goal.preferences.find((item) => item.key === operation.preference.key);
      return !existing || canonical({ value: existing.value, weight: existing.weight }) !== canonical({
        value: operation.preference.value,
        weight: operation.preference.weight,
      });
    }
    if (operation.kind === "GOAL_UPSERT_CONSTRAINT") {
      const existing = goal.hardConstraints.find((item) => item.key === operation.constraint.key);
      return !existing || canonical({ operator: existing.operator, value: existing.value }) !== canonical({
        operator: operation.constraint.operator,
        value: operation.constraint.value,
      });
    }
    return true;
  });
}

/**
 * Resolves conflicts in model-proposed operations and adds deterministic ordering actions.
 * It resolves conflicts and derives mechanical consequences only; it never
 * reparses the user's prose or invents a missing user intent.
 */
export function normalizeTurnPlanProposal(proposal: TurnPlanProposal, state: ConversationState): TurnPlanProposal {
  const latest = removeNoopCollectionUpserts(
    removeRedundantExploratoryMarketScope(keepLatestMutations(proposal.ops), state),
    state,
  );
  const operations: ProposedTurnOperation[] = [];
  for (const operation of latest) {
    operations.push(operation);
    if (state.workingSet
      && operation.kind === "GOAL_UPSERT_PREFERENCE"
      && derivesPriceOrder(operation.preference.key)
      && !latest.some((candidate) => candidate.kind === "SORT_WORKING_SET_BY_PRICE" && candidate.preferenceKey === operation.preference.key)) {
      operations.push({
        opId: uniqueOpId("executor-derived-price-rerank", [...latest, ...operations]),
        kind: "SORT_WORKING_SET_BY_PRICE",
        preferenceKey: operation.preference.key,
      });
    }
  }
  return { ...proposal, ops: operations };
}
