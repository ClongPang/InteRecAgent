from __future__ import annotations

import json
from collections import defaultdict

from pydantic import BaseModel, Field

from ...dto.goal import ShoppingGoal
from ...dto.goal_ops import GoalOperation, GoalOperationKind


class GoalOperationConflict(BaseModel):
    code: str
    key: str
    op_ids: list[str] = Field(default_factory=list)
    message: str


class GoalValidationResult(BaseModel):
    operations: list[GoalOperation] = Field(default_factory=list)
    conflicts: list[GoalOperationConflict] = Field(default_factory=list)

    @property
    def requires_clarification(self) -> bool:
        return bool(self.conflicts)


def _mutation_key(op: GoalOperation) -> str | None:
    if op.kind == GoalOperationKind.SET_TARGET:
        return "target"
    if op.kind == GoalOperationKind.UPSERT_CONSTRAINT:
        return f"constraint:{op.payload.get('facet')}"
    if op.kind == GoalOperationKind.SET_RETRIEVAL_SCOPE:
        fields = sorted(op.payload)
        return f"scope:{','.join(fields)}"
    if op.kind == GoalOperationKind.ADD_PREFERENCE:
        return f"preference:{op.payload.get('facet')}"
    return None


def _semantic_payload(op: GoalOperation) -> str:
    def normalize(value):
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value

    return json.dumps(normalize(op.payload), ensure_ascii=False, sort_keys=True, default=str)


def _merge_group(
    key: str, group: list[GoalOperation]
) -> tuple[GoalOperation | None, GoalOperationConflict | None]:
    merged: dict = {}
    authorities: dict[str, str] = {}
    for op in group:
        for field, value in op.payload.items():
            if field not in merged:
                merged[field] = value
                authorities[field] = op.origin
                continue
            probe = op.model_copy(update={"payload": {field: value}})
            current = op.model_copy(update={"payload": {field: merged[field]}})
            if _semantic_payload(probe) == _semantic_payload(current):
                continue
            previous_origin = authorities[field]
            if op.origin == "deterministic" and previous_origin != "deterministic":
                merged[field] = value
                authorities[field] = op.origin
                continue
            if op.origin != "deterministic" and previous_origin == "deterministic":
                continue
            return None, GoalOperationConflict(
                code="conflicting_operations",
                key=f"{key}:{field}",
                op_ids=[item.op_id for item in group],
                message=f"同一轮对 {key} 的 {field} 给出了互相冲突的值，需要确认。",
            )
    representative = next((op for op in group if op.origin == "deterministic"), group[0])
    return representative.model_copy(update={"payload": merged}), None


def validate_goal_operations(
    goal: ShoppingGoal, operations: list[GoalOperation]
) -> GoalValidationResult:
    """Validate a complete operation batch before its atomic reduction.

    Deterministic extraction wins over model inference. Conflicting operations
    of equal authority are rejected as a batch and surfaced for clarification.
    """
    conflicts: list[GoalOperationConflict] = []
    valid: list[GoalOperation] = []
    for op in operations:
        if op.precondition_goal_version != goal.goal_version:
            conflicts.append(
                GoalOperationConflict(
                    code="stale_goal_version",
                    key="goal_version",
                    op_ids=[op.op_id],
                    message="目标已在本轮处理期间变化，请基于最新状态重试。",
                )
            )
            continue
        if op.kind == GoalOperationKind.UPSERT_CONSTRAINT:
            facet = str(op.payload.get("facet") or "")
            if not facet:
                conflicts.append(
                    GoalOperationConflict(
                        code="invalid_constraint",
                        key="constraint",
                        op_ids=[op.op_id],
                        message="约束缺少维度，无法安全应用。",
                    )
                )
                continue
            if facet == "budget":
                value = op.payload.get("value")
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                    conflicts.append(
                        GoalOperationConflict(
                            code="invalid_budget",
                            key="constraint:budget",
                            op_ids=[op.op_id],
                            message="预算必须是大于 0 的数值。",
                        )
                    )
                    continue
        valid.append(op)

    groups: dict[str, list[GoalOperation]] = defaultdict(list)
    passthrough: list[GoalOperation] = []
    for op in valid:
        key = _mutation_key(op)
        if key is None:
            passthrough.append(op)
        else:
            groups[key].append(op)

    resolved: list[GoalOperation] = []
    for key, group in groups.items():
        unique = {_semantic_payload(op) for op in group}
        if len(unique) == 1:
            resolved.append(group[0])
            continue
        merged, conflict = _merge_group(key, group)
        if conflict is not None:
            conflicts.append(conflict)
        elif merged is not None:
            resolved.append(merged)

    if conflicts:
        return GoalValidationResult(conflicts=conflicts)
    by_id = {op.op_id: op for op in [*resolved, *passthrough]}
    ordered = [by_id[op.op_id] for op in valid if op.op_id in by_id]
    return GoalValidationResult(operations=ordered)
