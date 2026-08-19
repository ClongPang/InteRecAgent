"""合并条件与候选决策节点。"""
from __future__ import annotations

from ...application.dto import MissionConstraints, MissionStage
from ...application.services.rec import preference_hits, rank_with_belief, rec_state_from_mission
from ...domain.models import NormalizedProduct
from ...domain.policies import (
    apply_budget_filter,
    apply_exclusion_filter,
    apply_stock_filter,
    convert_products,
    dedupe_products,
    derive_title_attrs,
)
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
        updated = mission.model_copy(
            update={
                "constraints": merged,
                "stage": MissionStage.SEARCHING,
                "active_run_id": state["run_id"],
            }
        )
        return {
            "mission": updated,
            "constraints_before": constraints,
            "requires_clarification": False,
        }

    return merge_mission_state


def make_normalize_and_deduplicate():
    """去重 + 汇率换算（商品已由源归一化；汇率换算必须在预算过滤之前）。"""

    async def normalize_and_deduplicate(state: MissionGraphState) -> dict:
        products = [derive_title_attrs(item) for item in dedupe_products(state.get("products", []))]
        products = convert_products(products, state.get("rates", {}))
        return {"products": products}

    return normalize_and_deduplicate


def make_filter_hard_constraints():
    """硬过滤：否定候选、有货事实、排除词、预算。无库存事实时不筛。"""

    async def filter_hard_constraints(state: MissionGraphState) -> dict:
        constraints = state["mission"].constraints
        products: list[NormalizedProduct] = state.get("products", [])
        warnings: list[str] = []

        rejected = set(getattr(state["mission"].belief, "rejected_snapshot_ids", []) or [])
        snapshot_map = state.get("snapshot_map") or {}
        if rejected:
            before = len(products)
            products = [
                product
                for product in products
                if snapshot_map.get(product.id, product.id) not in rejected
                and product.id not in rejected
            ]
            if len(products) < before:
                warnings.append(f"已排除 {before - len(products)} 件被否定的候选")

        if constraints.only_in_stock:
            kept, out, unknown = apply_stock_filter(products)
            if any(item.in_stock is not None for item in state.get("products", [])):
                products = kept
                if out:
                    warnings.append(f"{len(out)} 件无货，已按「仅看有货」去掉")
                if unknown:
                    warnings.append(f"{len(unknown)} 件没有库存事实，未列入仅看有货结果")
            else:
                warnings.append("当前候选没有库存事实，「仅看有货」未生效")

        if constraints.excluded_terms:
            products, dropped = apply_exclusion_filter(products, constraints.excluded_terms)
            if dropped:
                warnings.append(
                    f"已按排除词过滤 {len(dropped)} 件（标题匹配：{'、'.join(constraints.excluded_terms)}）"
                )

        if constraints.budget_cny is not None:
            kept, over, fx_failed = apply_budget_filter(products, constraints.budget_cny)
            products = kept + fx_failed
            if over:
                warnings.append(f"{len(over)} 件商品超出预算 {constraints.budget_cny:.0f} 元")

        return {"products": products, "warnings": warnings}

    return filter_hard_constraints


def _category_supports_audio_preference(query: str) -> bool:
    return "耳机" in query or "headphone" in query.lower() or "降噪" in query


def make_rank_candidates():
    """多目标排序。信念与标题派生进入打分；无线索时只警告，不编造分数。"""

    async def rank_candidates(state: MissionGraphState) -> dict:
        mission = state["mission"]
        products = state.get("products", [])
        warnings: list[str] = []
        rec = rec_state_from_mission(mission)
        preference = rec.preference
        if preference in {"battery", "noise"}:
            hits = preference_hits(products, preference)
            if hits == 0:
                warnings.append(f"当前候选标题没有「{preference}」线索，已主要按商品价排序")
            elif not _category_supports_audio_preference(rec.query or ""):
                warnings.append(f"当前商品数据无法按「{preference}」维度排序，已按商品价排序")

        rejected = {
            source_id
            for source_id, snapshot_id in (state.get("snapshot_map") or {}).items()
            if snapshot_id in rec.rejected_snapshot_ids
        }
        ranked: list[NormalizedProduct] = rank_with_belief(
            products, rec, rejected_source_ids=rejected
        )
        return {"ranked": ranked, "warnings": warnings}

    return rank_candidates
