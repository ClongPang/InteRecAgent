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

/**
 * Compiles model-proposed semantic effects into an executable proposal.
 * It resolves conflicts and derives mechanical consequences only; it never
 * reparses the user's prose or invents a missing user intent.
 */
export function compileTurnIntent(proposal: TurnPlanProposal, state: ConversationState): TurnPlanProposal {
  const latest = keepLatestMutations(proposal.ops);
  const operations: ProposedTurnOperation[] = [];
  for (const operation of latest) {
    operations.push(operation);
    if (state.workingSet
      && operation.kind === "GOAL_UPSERT_PREFERENCE"
      && derivesPriceOrder(operation.preference.key)
      && !latest.some((candidate) => candidate.kind === "RERANK_WORKING_SET" && candidate.preferenceKey === operation.preference.key)) {
      operations.push({
        opId: uniqueOpId("host-derived-price-rerank", [...latest, ...operations]),
        kind: "RERANK_WORKING_SET",
        preferenceKey: operation.preference.key,
      });
    }
  }
  return { ...proposal, ops: operations };
}
