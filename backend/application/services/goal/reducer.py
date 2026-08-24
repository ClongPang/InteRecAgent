from __future__ import annotations

from ...dto.goal import (
    ConstraintStatus,
    GoalConstraint,
    GoalRejectedEntity,
    GoalTarget,
    RejectedEntityKind,
    RetrievalScope,
    ShoppingGoal,
)
from ...dto.goal_ops import GoalOperation, GoalOperationKind


def apply_goal_operations(goal: ShoppingGoal, operations: list[GoalOperation]) -> ShoppingGoal:
    """有序、可重放 reducer；整批操作必须基于同一 goal_version。"""
    if any(op.precondition_goal_version != goal.goal_version for op in operations):
        raise ValueError("goal version conflict")
    target = goal.target
    constraints = list(goal.constraints)
    preferences = list(goal.preferences)
    scope = goal.retrieval_scope
    rejected_entities = list(goal.rejected_entities)
    unresolved = list(goal.unresolved)
    changed = False
    for op in operations:
        if op.kind == GoalOperationKind.SET_TARGET:
            updated_target = GoalTarget(**{**target.model_dump(), **op.payload})
            if updated_target != target:
                target = updated_target
                changed = True
        elif op.kind == GoalOperationKind.UPSERT_CONSTRAINT:
            facet = str(op.payload["facet"])
            active = next(
                (
                    item
                    for item in reversed(constraints)
                    if item.facet == facet and item.status == ConstraintStatus.ACTIVE
                ),
                None,
            )
            comparison = GoalConstraint(
                constraint_id=active.constraint_id if active else f"{op.op_id}:{facet}",
                source_turn_id=active.source_turn_id if active else op.source_turn_id,
                source_span=active.source_span if active else op.source_span,
                **op.payload,
            )
            if active is not None and comparison == active:
                continue
            updated: list[GoalConstraint] = []
            for item in constraints:
                if item.facet == facet and item.status == ConstraintStatus.ACTIVE:
                    updated.append(item.model_copy(update={"status": ConstraintStatus.SUPERSEDED}))
                else:
                    updated.append(item)
            updated.append(
                GoalConstraint(
                    constraint_id=f"{op.op_id}:{facet}",
                    source_turn_id=op.source_turn_id,
                    source_span=op.source_span,
                    **op.payload,
                )
            )
            constraints = updated
            changed = True
        elif op.kind == GoalOperationKind.SET_RETRIEVAL_SCOPE:
            updated_scope = scope.model_copy(update=op.payload)
            if updated_scope != scope:
                scope = updated_scope
                changed = True
        elif op.kind == GoalOperationKind.RETRACT_CONSTRAINT:
            ident = op.payload.get("constraint_id")
            updated_constraints = [
                item.model_copy(update={"status": ConstraintStatus.RETRACTED})
                if item.constraint_id == ident and item.status == ConstraintStatus.ACTIVE
                else item
                for item in constraints
            ]
            if updated_constraints != constraints:
                constraints = updated_constraints
                changed = True
        elif op.kind == GoalOperationKind.ADD_PREFERENCE:
            facet = str(op.payload["facet"])
            candidate = GoalConstraint(
                constraint_id=f"{op.op_id}:{facet}",
                hardness="soft",
                unknown_policy="allow",
                source_turn_id=op.source_turn_id,
                source_span=op.source_span,
                **op.payload,
            )
            if not any(
                item.facet == candidate.facet
                and item.value == candidate.value
                and item.status == ConstraintStatus.ACTIVE
                for item in preferences
            ):
                preferences = [
                    item.model_copy(update={"status": ConstraintStatus.SUPERSEDED})
                    if item.facet == facet and item.status == ConstraintStatus.ACTIVE
                    else item
                    for item in preferences
                ]
                preferences.append(candidate)
                changed = True
        elif op.kind == GoalOperationKind.REJECT_CANDIDATE:
            raw_kind = str(op.payload.get("entity_type") or RejectedEntityKind.SNAPSHOT)
            entity_id = str(
                op.payload.get("entity_id") or op.payload.get("candidate_id") or ""
            ).strip()
            if entity_id:
                rejected_candidate = GoalRejectedEntity(
                    kind=RejectedEntityKind(raw_kind),
                    value=entity_id,
                    reason=str(op.payload.get("reason") or "") or None,
                    source_turn_id=op.source_turn_id,
                )
                if not any(
                    item.kind == rejected_candidate.kind
                    and item.value == rejected_candidate.value
                    for item in rejected_entities
                ):
                    rejected_entities.append(rejected_candidate)
                    changed = True
        elif op.kind == GoalOperationKind.CORRECT_UNDERSTANDING:
            # 纠错是审计语义；同批 SET/UPSERT/RETRACT 才负责修改 Goal。
            continue
        elif op.kind == GoalOperationKind.UNDO and isinstance(op.payload.get("goal"), dict):
            restored = ShoppingGoal.model_validate(op.payload["goal"])
            target = restored.target
            constraints = list(restored.constraints)
            preferences = list(restored.preferences)
            scope = RetrievalScope.model_validate(restored.retrieval_scope)
            rejected_entities = list(restored.rejected_entities)
            unresolved = list(restored.unresolved)
            changed = restored.model_copy(update={"goal_version": goal.goal_version}) != goal
    return goal.model_copy(
        update={
            "goal_version": goal.goal_version + (1 if changed else 0),
            "target": target,
            "constraints": constraints,
            "preferences": preferences,
            "retrieval_scope": scope,
            "rejected_entities": rejected_entities,
            "unresolved": unresolved,
        }
    )
