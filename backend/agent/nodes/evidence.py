"""Build an evidence-grounded recommendation draft from ranked candidates."""
from __future__ import annotations

from ...application.dto import RecommendationDraft
from ..state import MissionGraphState


def _fact_rationale(primary, constraints) -> list[str]:
    reasons: list[str] = []
    if constraints.budget_cny is not None and primary.rmb_price is not None:
        reasons.append(
            f"商品估算价 {primary.rmb_price:.0f} 元在预算 {constraints.budget_cny:.0f} 元内"
        )
    elif constraints.budget_cny is None:
        reasons.append("当前可检索结果中商品估算价格较低")
    if primary.fx_failed:
        reasons.append("该币种汇率暂不可用，保留原币价格供参考")
    return reasons or ["当前可检索结果中的合理选择"]


def make_verify_evidence():
    """Build a deterministic draft that cites ranked candidates only."""

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
            tradeoffs=[
                "库存/规格信息未提供，需要到商户页确认",
                "运费与税费以商户结算页为准",
            ],
            cited_evidence_ids=[primary.id] + [p.id for p in alternatives],
        )
        return {"recommendation": draft}

    return verify_evidence
