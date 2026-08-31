import { DomainError } from "./errors.js";
import { canonicalCategoryHint } from "./candidate-ranking-types.js";
import { canonicalDecimal } from "./money.js";
import type { EntityRef, GoalOperation, GoalRevision, ShoppingGoal } from "./conversation-types.js";

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainError(code, code);
  return normalized;
}

function entityKey(entity: EntityRef): string {
  return `${entity.kind}:${entity.value.trim().toLocaleLowerCase()}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => requiredText(value, "INVALID_RETRIEVAL_MARKET").toUpperCase()))].sort();
}

export function emptyShoppingGoal(): ShoppingGoal {
  return {
    target: null,
    budget: null,
    retrievalMarkets: [],
    deliveryDestination: null,
    stockPreference: "ANY",
    hardConstraints: [],
    preferences: [],
    exclusions: [],
    unresolved: [],
  };
}

export function applyGoalOperations(base: ShoppingGoal, operations: GoalOperation[]): ShoppingGoal {
  const duplicateIds = operations.map((item) => item.opId).filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new DomainError("DUPLICATE_OPERATION_ID", duplicateIds[0]!);

  let goal: ShoppingGoal = structuredClone(base);
  for (const operation of operations) {
    switch (operation.kind) {
      case "GOAL_SET_TARGET":
        {
          const requestedCategory = requiredText(operation.target.categoryId, "INVALID_CATEGORY_ID");
          const categoryId = canonicalCategoryHint(requestedCategory);
          const targetText = operation.target.targetText?.normalize("NFKC").trim() || requestedCategory.normalize("NFKC").trim();
        goal = {
          ...goal,
          target: {
            ...operation.target,
            categoryId,
            targetText,
            canonicalModel: operation.target.canonicalModel?.trim() || null,
          },
        };
        break;
        }
      case "GOAL_CLEAR_TARGET":
        goal = { ...goal, target: null };
        break;
      case "GOAL_SET_BUDGET": {
        const amount = canonicalDecimal(operation.budget.amount);
        if (amount.startsWith("-") || amount === "0") throw new DomainError("NON_POSITIVE_BUDGET", "Budget must be positive");
        goal = { ...goal, budget: { amount, currency: requiredText(operation.budget.currency, "INVALID_BUDGET_CURRENCY").toUpperCase() } };
        break;
      }
      case "GOAL_CLEAR_BUDGET":
        goal = { ...goal, budget: null };
        break;
      case "GOAL_SET_RETRIEVAL_MARKETS":
        goal = { ...goal, retrievalMarkets: uniqueSorted(operation.markets) };
        break;
      case "GOAL_SET_DELIVERY_DESTINATION":
        goal = { ...goal, deliveryDestination: operation.destination?.trim() || null };
        break;
      case "GOAL_SET_STOCK_PREFERENCE":
        goal = { ...goal, stockPreference: operation.preference };
        break;
      case "GOAL_UPSERT_CONSTRAINT": {
        const key = requiredText(operation.constraint.key, "INVALID_CONSTRAINT_KEY");
        const next = { ...operation.constraint, key, source: operation.source };
        goal = { ...goal, hardConstraints: [...goal.hardConstraints.filter((item) => item.key !== key), next].sort((a, b) => a.key.localeCompare(b.key)) };
        break;
      }
      case "GOAL_REMOVE_CONSTRAINT": {
        const key = requiredText(operation.key, "INVALID_CONSTRAINT_KEY");
        goal = { ...goal, hardConstraints: goal.hardConstraints.filter((item) => item.key !== key) };
        break;
      }
      case "GOAL_UPSERT_PREFERENCE": {
        const key = requiredText(operation.preference.key, "INVALID_PREFERENCE_KEY");
        if (!Number.isFinite(operation.preference.weight) || operation.preference.weight < 0 || operation.preference.weight > 1) {
          throw new DomainError("INVALID_PREFERENCE_WEIGHT", key);
        }
        const next = { ...operation.preference, key, source: operation.source };
        goal = { ...goal, preferences: [...goal.preferences.filter((item) => item.key !== key), next].sort((a, b) => a.key.localeCompare(b.key)) };
        break;
      }
      case "GOAL_REMOVE_PREFERENCE": {
        const key = requiredText(operation.key, "INVALID_PREFERENCE_KEY");
        goal = { ...goal, preferences: goal.preferences.filter((item) => item.key !== key) };
        break;
      }
      case "GOAL_EXCLUDE_ENTITY": {
        const next = { ...operation.entity, value: requiredText(operation.entity.value, "INVALID_ENTITY_REF") };
        const key = entityKey(next);
        goal = { ...goal, exclusions: [...goal.exclusions.filter((item) => entityKey(item) !== key), next] };
        break;
      }
      case "GOAL_RESTORE_ENTITY": {
        const key = entityKey(operation.entity);
        goal = { ...goal, exclusions: goal.exclusions.filter((item) => entityKey(item) !== key) };
        break;
      }
      case "GOAL_ADD_GAP": {
        const slotId = requiredText(operation.gap.slotId, "INVALID_GOAL_GAP");
        const gap = { slotId, reasonCodes: [...new Set(operation.gap.reasonCodes)].sort(), askedByMessageId: operation.source.messageId };
        goal = { ...goal, unresolved: [...goal.unresolved.filter((item) => item.slotId !== slotId), gap].sort((a, b) => a.slotId.localeCompare(b.slotId)) };
        break;
      }
      case "GOAL_RESOLVE_GAP": {
        const slotId = requiredText(operation.slotId, "INVALID_GOAL_GAP");
        goal = { ...goal, unresolved: goal.unresolved.filter((item) => item.slotId !== slotId) };
        break;
      }
    }
  }
  return goal;
}

export function createGoalRevision(base: GoalRevision | null, operations: GoalOperation[], committedByTurnId: string, nextVersion = (base?.version ?? 0) + 1): GoalRevision {
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 1 || nextVersion <= (base?.version ?? 0)) {
    throw new DomainError("INVALID_GOAL_REVISION", `shopping goal revision must advance beyond its parent: ${nextVersion}`);
  }
  return {
    version: nextVersion,
    parentVersion: base?.version ?? null,
    goal: applyGoalOperations(base?.goal ?? emptyShoppingGoal(), operations),
    operations: structuredClone(operations),
    committedByTurnId: requiredText(committedByTurnId, "INVALID_TURN_ID"),
  };
}

export function exactPreviousGoalRevision(history: GoalRevision[], currentVersion: number): GoalRevision {
  const current = history.find((item) => item.version === currentVersion);
  if (!current || current.parentVersion === null) throw new DomainError("GOAL_REVISION_NOT_UNDOABLE", String(currentVersion));
  const previous = history.find((item) => item.version === current.parentVersion);
  if (!previous) throw new DomainError("GOAL_PARENT_REVISION_NOT_FOUND", String(current.parentVersion));
  return structuredClone(previous);
}
