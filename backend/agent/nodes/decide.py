"""合并条件与候选决策节点。"""

from __future__ import annotations

from ...application.dto import MissionConstraints, MissionStage
from ...application.dto.belief import SpecGate
from ...application.services.decide_oral import constraint_ops, fold_constraint_patch
from ...application.services.dialogue import sanitize_constraints
from ...application.services.goal import (
    apply_goal_operations,
    belief_view_from_goal,
    compile_constraint_operations,
    compile_goal_operations,
    compile_preference_operations,
    compile_rejection_operations,
    constraint_view_from_goal,
    ensure_goal_authority,
    validate_goal_operations,
)
from ...application.services.parse_intent import (
    CLARIFYING_QUESTION,
    canonicalize_spec_gates,
    sanitize_inferred_merchants,
)
from ...application.services.rec import rec_state_from_mission, run_filter, run_rank
from ...application.services.uncertainty import resolve_probe_coverage
from ...domain.product_ontology import SUPPORTED_ITEM_TYPES
from ..state import MissionGraphState

_ITEM_TYPE_LABELS = {
    "smartphone": "手机",
    "headphones": "耳机",
    "monitor": "显示器",
}
_ITEM_TYPE_ORDER = ("smartphone", "headphones", "monitor")


def released_category_clarification(item_types: frozenset[str]) -> str:
    labels = [
        _ITEM_TYPE_LABELS[item_type]
        for item_type in _ITEM_TYPE_ORDER
        if item_type in item_types
    ]
    labels.extend(
        sorted(item_type for item_type in item_types if item_type not in _ITEM_TYPE_LABELS)
    )
    released = "、".join(labels) if labels else "（暂无）"
    return (
        f"当前经过资格与证据验收并开放的品类只有{released}；其他品类尚未开放，"
        "请先改为上述已开放品类之一。"
    )


def make_merge_mission_state(*, enabled_item_types: frozenset[str] | None = None):
    """将 IntentPatch 合并进任务约束，不递增 constraints_version。
    版本只在约束内容变化时推进：PATCH/undo 由命令层、消息路径由 persist。"""

    async def merge_mission_state(state: MissionGraphState) -> dict:
        item_types = SUPPORTED_ITEM_TYPES if enabled_item_types is None else enabled_item_types
        mission = state["mission"]
        authoritative_goal = ensure_goal_authority(
            mission.goal,
            mission.constraints,
            version=max(mission.goal.goal_version, mission.constraints_version),
            belief=state.get("belief_before", mission.belief),
        )
        authoritative_constraints = constraint_view_from_goal(
            authoritative_goal, fallback=mission.constraints
        )
        if state.get("skip_intent_patch"):
            projected_goal = authoritative_goal
            if not authoritative_constraints.query:
                return {
                    "requires_clarification": True,
                    "clarification_question": CLARIFYING_QUESTION,
                    "constraints_before": authoritative_constraints,
                    "mission": mission.model_copy(
                        update={
                            "stage": MissionStage.CLARIFYING,
                            "active_run_id": state["run_id"],
                            "goal": projected_goal,
                        }
                    ),
                }
            return {
                "mission": mission.model_copy(
                    update={
                        "stage": MissionStage.SEARCHING,
                        "active_run_id": state["run_id"],
                        "goal": projected_goal,
                    }
                ),
                "constraints_before": authoritative_constraints,
                "requires_clarification": False,
            }

        act = state.get("dialogue_act")
        plan = state.get("turn_plan")
        if plan is not None and constraint_ops(plan):
            patch = fold_constraint_patch(authoritative_constraints, plan)
        elif act is not None and act.kind.value in {
            "ask_about_item",
            "ask_about_set",
            "compare_items",
            "meta",
            "undo",
        }:
            return {
                "mission": mission.model_copy(update={"active_run_id": state["run_id"]}),
                "constraints_before": authoritative_constraints,
                "requires_clarification": False,
            }
        else:
            patch = state["intent_patch"]
        constraints = authoritative_constraints

        needs_clarification = bool(patch.requires_clarification and not constraints.query)

        excluded = list(constraints.excluded_terms)
        extra = list(act.exclude_terms) if act is not None else []
        for term in list(patch.exclude_terms or []) + extra:
            if term and term not in excluded:
                excluded.append(term)
        patch_merchants = patch.merchants
        if patch.source == "model":
            patch_merchants = sanitize_inferred_merchants(patch_merchants)
        merged = MissionConstraints(
            query=patch.query or constraints.query,
            budget_cny=patch.budget_cny if patch.budget_cny is not None else constraints.budget_cny,
            markets=patch.markets or constraints.markets,
            preference=patch.preference or constraints.preference,
            only_in_stock=(
                patch.only_in_stock
                if patch.only_in_stock is not None
                else constraints.only_in_stock
            ),
            excluded_terms=excluded,
            merchants=list(patch_merchants)
            if patch_merchants is not None
            else list(constraints.merchants),
        )
        # 约束级护栏：无音频规格时不写入 noise/battery 排序偏好（不假装已按该维度排序）。
        # 控制反转后此护栏从命令层 DialoguePolicy 下沉到运行时唯一路径。
        merged, warnings, _replies = sanitize_constraints(constraints.query, constraints, merged)
        update: dict = {
            "constraints": merged,
            "stage": MissionStage.CLARIFYING if needs_clarification else MissionStage.SEARCHING,
            "active_run_id": state["run_id"],
        }
        # Goal is the sole writable aggregate. Legacy constraints are an adapter.
        goal = authoritative_goal
        raw_text = str(state.get("text") or "")
        patch_operations = compile_constraint_operations(
            constraints,
            merged,
            goal=goal,
            source_turn_id=state.get("run_id"),
            origin=str(getattr(patch, "source", None) or "model"),
        )
        deterministic_operations = compile_goal_operations(
            raw_text,
            goal_version=goal.goal_version,
            source_turn_id=state.get("run_id"),
            current_item_type=goal.target.item_type,
        )
        belief = mission.belief
        if patch.use_case:
            belief = belief.with_use_case(patch.use_case)
        normalized_spec_gates = canonicalize_spec_gates(list(patch.spec_gates or []))
        if normalized_spec_gates:
            belief = belief.with_spec_gates(normalized_spec_gates)
        if patch.soft_prefs:
            belief = belief.with_soft_prefs(patch.soft_prefs)
        if act is not None:
            belief = resolve_probe_coverage(belief, act, before=constraints, after=merged)
        preference_operations = compile_preference_operations(
            goal_version=goal.goal_version,
            source_turn_id=state.get("run_id"),
            origin=str(getattr(patch, "source", None) or "model"),
            soft_prefs=list(belief.soft),
            spec_gates=list(belief.spec_gates),
            use_case=belief.use_case,
            price_sensitivity=belief.price_sensitivity,
        )
        rejection_operations = compile_rejection_operations(
            goal=goal,
            source_turn_id=state.get("run_id"),
            snapshot_ids=list(mission.belief.rejected_snapshot_ids),
            listing_keys=list(mission.belief.rejected_listing_keys),
        )
        validation = validate_goal_operations(
            goal,
            [
                *patch_operations,
                *deterministic_operations,
                *preference_operations,
                *rejection_operations,
            ],
        )
        operations = validation.operations
        canonical_goal = apply_goal_operations(goal, operations) if operations else goal
        update["goal"] = canonical_goal
        update["constraints"] = constraint_view_from_goal(canonical_goal, fallback=merged)
        if validation.requires_clarification:
            needs_clarification = True
            update["stage"] = MissionStage.CLARIFYING
        unsupported_item_type = (
            canonical_goal.target.item_type and canonical_goal.target.item_type not in item_types
        )
        if unsupported_item_type:
            needs_clarification = True
            update["stage"] = MissionStage.CLARIFYING
        # 开放式软偏好维度并入信念，让排序按通用维度打分（§5.1 天花板）。
        update["belief"] = belief_view_from_goal(canonical_goal, fallback=belief)
        updated = mission.model_copy(update=update)
        result: dict = {
            "mission": updated,
            "constraints_before": constraints,
            "requires_clarification": needs_clarification,
            "clarification_question": (
                released_category_clarification(item_types)
                if unsupported_item_type
                else (
                    validation.conflicts[0].message
                    if validation.conflicts
                    else (patch.clarification_question if needs_clarification else None)
                )
            ),
            "goal_operations": [item.model_dump(mode="json") for item in operations],
        }
        combined_warnings = [*warnings, *[item.message for item in validation.conflicts]]
        if combined_warnings:
            result["warnings"] = combined_warnings
        return result

    return merge_mission_state


def make_filter_hard_constraints(*, enabled_item_types: frozenset[str] | None = None):
    """硬过滤节点（refilter 路径）。逻辑委托给共享流水线 run_filter，保证与研究工具一致。"""

    async def filter_hard_constraints(state: MissionGraphState) -> dict:
        mission = state["mission"]
        goal = ensure_goal_authority(
            mission.goal,
            mission.constraints,
            version=max(mission.goal.goal_version, mission.constraints_version),
            belief=mission.belief,
        )
        rec = rec_state_from_mission(mission.model_copy(update={"goal": goal}))
        products, warnings = run_filter(
            constraint_view_from_goal(goal, fallback=mission.constraints),
            state.get("products", []),
            rejected_snapshot_ids=set(rec.rejected_snapshot_ids),
            rejected_listing_keys=set(rec.rejected_listing_keys),
            spec_gates=[
                SpecGate(attr=attr, cues=list(cues), required=required)
                for attr, cues, required in rec.spec_gates
            ],
            snapshot_map=state.get("snapshot_map") or {},
            goal=goal,
            enabled_item_types=enabled_item_types,
        )
        return {"products": products, "warnings": warnings}

    return filter_hard_constraints


def make_rank_candidates():
    """多目标排序节点（refilter/rerank 路径）。逻辑委托给共享流水线 run_rank。"""

    async def rank_candidates(state: MissionGraphState) -> dict:
        ranked, warnings = run_rank(
            state["mission"],
            state.get("products", []),
            snapshot_map=state.get("snapshot_map") or {},
        )
        return {"ranked": ranked, "warnings": warnings}

    return rank_candidates
