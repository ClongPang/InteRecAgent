"""合并条件与候选决策节点。"""
from __future__ import annotations

from ...application.dto import MissionConstraints, MissionStage
from ...application.services.dialogue import sanitize_constraints
from ...application.services.rec import run_filter, run_rank
from ..state import MissionGraphState
from .parse_intent import CLARIFYING_QUESTION


def make_merge_mission_state():
    """将 IntentPatch 合并进任务约束，不递增 constraints_version。
    版本只在约束内容变化时推进：PATCH/undo 由命令层、消息路径由 persist。"""

    async def merge_mission_state(state: MissionGraphState) -> dict:
        mission = state["mission"]
        if state.get("skip_intent_patch"):
            if not mission.constraints.query:
                return {
                    "requires_clarification": True,
                    "clarification_question": CLARIFYING_QUESTION,
                    "constraints_before": mission.constraints,
                    "mission": mission.model_copy(
                        update={
                            "stage": MissionStage.CLARIFYING,
                            "active_run_id": state["run_id"],
                        }
                    ),
                }
            return {
                "mission": mission.model_copy(
                    update={
                        "stage": MissionStage.SEARCHING,
                        "active_run_id": state["run_id"],
                    }
                ),
                "constraints_before": mission.constraints,
                "requires_clarification": False,
            }

        act = state.get("dialogue_act")
        if act is not None and act.kind.value in {
            "ask_about_item",
            "compare_items",
            "meta",
            "undo",
        }:
            return {
                "mission": mission.model_copy(update={"active_run_id": state["run_id"]}),
                "constraints_before": mission.constraints,
                "requires_clarification": False,
            }

        patch = state["intent_patch"]
        constraints = mission.constraints

        if patch.requires_clarification and not constraints.query:
            return {
                "requires_clarification": True,
                "clarification_question": patch.clarification_question,
                "constraints_before": constraints,
            }

        excluded = list(constraints.excluded_terms)
        extra = list(act.exclude_terms) if act is not None else []
        for term in list(patch.exclude_terms or []) + extra:
            if term and term not in excluded:
                excluded.append(term)
        merged = MissionConstraints(
            query=patch.query or constraints.query,
            budget_cny=patch.budget_cny if patch.budget_cny is not None else constraints.budget_cny,
            markets=patch.markets or constraints.markets,
            preference=patch.preference or constraints.preference,
            only_in_stock=(
                patch.only_in_stock if patch.only_in_stock is not None else constraints.only_in_stock
            ),
            excluded_terms=excluded,
        )
        # 约束级护栏：无音频规格时不写入 noise/battery 排序偏好（不假装已按该维度排序）。
        # 控制反转后此护栏从命令层 DialoguePolicy 下沉到运行时唯一路径。
        merged, warnings, _replies = sanitize_constraints(constraints.query, constraints, merged)
        update: dict = {
            "constraints": merged,
            "stage": MissionStage.SEARCHING,
            "active_run_id": state["run_id"],
        }
        # 开放式软偏好维度并入信念，让排序按通用维度打分（§5.1 天花板）。
        if patch.soft_prefs:
            update["belief"] = mission.belief.with_soft_prefs(patch.soft_prefs)
        updated = mission.model_copy(update=update)
        result: dict = {
            "mission": updated,
            "constraints_before": constraints,
            "requires_clarification": False,
        }
        if warnings:
            result["warnings"] = warnings
        return result

    return merge_mission_state


def make_filter_hard_constraints():
    """硬过滤节点（refilter 路径）。逻辑委托给共享流水线 run_filter，保证与研究工具一致。"""

    async def filter_hard_constraints(state: MissionGraphState) -> dict:
        mission = state["mission"]
        products, warnings = run_filter(
            mission.constraints,
            state.get("products", []),
            rejected_snapshot_ids=set(getattr(mission.belief, "rejected_snapshot_ids", []) or []),
            snapshot_map=state.get("snapshot_map") or {},
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
