import { DomainError } from "./errors.js";
import type { ConversationRoute, GoalOperation, TurnOperation, TurnPlan } from "./conversation-types.js";

export const MAX_TURN_OPERATIONS = 12;

function isGoalOperation(operation: TurnOperation): operation is GoalOperation {
  return operation.kind.startsWith("GOAL_");
}

export function validateTurnPlan(plan: TurnPlan): TurnPlan {
  const summary = plan.userIntentSummary.trim();
  if (!summary) throw new DomainError("TURN_INTENT_SUMMARY_REQUIRED", "Turn intent summary is required");
  if (plan.ops.length < 1 || plan.ops.length > MAX_TURN_OPERATIONS) throw new DomainError("TURN_OPERATION_BUDGET_EXCEEDED", String(plan.ops.length));
  if (plan.leftover.length > 4) throw new DomainError("PENDING_OPERATION_BUDGET_EXCEEDED", String(plan.leftover.length));

  const ids = [...plan.ops.map((item) => item.opId), ...plan.leftover.map((item) => item.operation.opId)];
  if (new Set(ids).size !== ids.length) throw new DomainError("DUPLICATE_OPERATION_ID", ids.join(","));
  if (plan.ops.filter((item) => item.kind === "RESEARCH_OFFERS").length > 1) throw new DomainError("MULTIPLE_RESEARCH_OPERATIONS", "At most one research operation is allowed");

  const hasUndo = plan.ops.some((item) => item.kind === "UNDO_REVISION");
  if (hasUndo && plan.ops.some(isGoalOperation)) throw new DomainError("UNDO_AND_GOAL_PATCH_CONFLICT", "Undo and goal mutation cannot share a turn");

  return { ops: structuredClone(plan.ops), leftover: structuredClone(plan.leftover), userIntentSummary: summary };
}

export function routeForTurnPlan(input: TurnPlan): ConversationRoute {
  const plan = validateTurnPlan(input);
  if (plan.ops.some((item) => item.kind === "REQUEST_CLARIFICATION")) return "clarify";
  if (plan.ops.some((item) => item.kind === "RESEARCH_OFFERS")) return "research";
  if (plan.ops.some((item) => item.kind === "REJECT_OFFERS" || item.kind === "RESTORE_OFFERS" || item.kind === "REFILTER_WORKING_SET")) return "refilter";
  if (plan.ops.some((item) => item.kind === "RERANK_WORKING_SET")) return "rerank";
  return "talk";
}
