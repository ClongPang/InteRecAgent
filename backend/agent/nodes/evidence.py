"""证据校验与推荐组合节点。"""
from __future__ import annotations

from ...application.dto import RecommendationDraft, RunnerStatus
from ...application.errors import ModelUnavailableError
from ...application.ports import ModelBackend
from ...application.services.model_context import draft_candidates
from ..state import MissionGraphState


def _fact_rationale(primary, constraints) -> list[str]:
    reasons: list[str] = []
    if constraints.budget_cny is not None and primary.rmb_price is not None:
        reasons.append(f"商品价估算 {primary.rmb_price:.0f} 元在预算 {constraints.budget_cny:.0f} 元内")
    elif constraints.budget_cny is None:
        reasons.append("当前可检索结果中商品价估算较低")
    if primary.fx_failed:
        reasons.append("该币种汇率暂不可用，保留原币价供参考")
    return reasons or ["当前可检索结果中的合理选择"]


def make_verify_evidence():
    """依据已排序候选构建证据草稿；只引用存在于候选中的事实（AGT-004）。"""

    async def verify_evidence(state: MissionGraphState) -> dict:
        ranked = state.get("ranked", [])
        if not ranked:
            return {"recommendation": None}
        constraints = state["mission"].constraints
        primary = ranked[0]
        alternatives = ranked[1:3]
        draft = RecommendationDraft(
            primary_snapshot_id=primary.id,
            alternative_snapshot_ids=[p.id for p in alternatives],
            rationale=_fact_rationale(primary, constraints),
            tradeoffs=["库存/规格信息未提供，需要到商户页确认", "运费与税费以商户结算页为准"],
            cited_evidence_ids=[primary.id] + [p.id for p in alternatives],
        )
        return {"recommendation": draft}

    return verify_evidence


def make_compose_recommendation(model_backend: ModelBackend | None = None):
    """模型可起草推荐；最终仍校验 ID。模型失败则保留确定性草稿（AC-009）。"""

    async def compose_recommendation(state: MissionGraphState) -> dict:
        ranked = state.get("ranked", [])
        draft = state.get("recommendation")
        if not ranked:
            return {
                "recommendation": None,
                "status": RunnerStatus.DEGRADED,
                "warnings": ["无可用候选，无法生成推荐"],
            }
        if model_backend is not None and model_backend.is_configured():
            try:
                draft = await model_backend.draft_recommendation(
                    constraints=state["mission"].constraints,
                    candidates=draft_candidates(
                        ranked,
                        compare_ids=list(state["mission"].comparison_snapshot_ids or []),
                    ),
                    evidence=draft,
                )
            except ModelUnavailableError:
                pass
        if draft is None:
            return {
                "recommendation": None,
                "status": RunnerStatus.DEGRADED,
                "warnings": ["无可用候选，无法生成推荐"],
            }
        valid_ids = {p.id for p in ranked}
        primary = draft.primary_snapshot_id if draft.primary_snapshot_id in valid_ids else None
        if primary is None:
            primary = ranked[0].id
        return {
            "recommendation": RecommendationDraft(
                primary_snapshot_id=primary,
                alternative_snapshot_ids=[
                    i for i in draft.alternative_snapshot_ids if i in valid_ids
                ],
                rationale=draft.rationale,
                tradeoffs=draft.tradeoffs,
                cited_evidence_ids=[i for i in draft.cited_evidence_ids if i in valid_ids],
            )
        }

    return compose_recommendation
