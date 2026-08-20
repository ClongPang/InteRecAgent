"""把任务约束与信念收成排序/检索共用的 RecState。"""
from __future__ import annotations

from dataclasses import dataclass

from ...dto.mission import ShoppingMission


@dataclass(frozen=True)
class RecState:
    query: str | None
    budget_cny: float | None
    markets: tuple[str, ...]
    preference: str
    only_in_stock: bool
    excluded_terms: tuple[str, ...]
    rejected_snapshot_ids: frozenset[str]
    rejected_listing_keys: frozenset[str]
    soft_prefs: tuple[tuple[str, str, str, tuple[str, ...]], ...]
    use_case: str | None
    price_sensitivity: str | None


def rec_state_from_mission(mission: ShoppingMission) -> RecState:
    constraints = mission.constraints
    belief = mission.belief
    return RecState(
        query=constraints.query,
        budget_cny=constraints.budget_cny,
        markets=tuple(constraints.markets),
        preference=constraints.preference,
        only_in_stock=constraints.only_in_stock,
        excluded_terms=tuple(constraints.excluded_terms),
        rejected_snapshot_ids=frozenset(belief.rejected_snapshot_ids),
        rejected_listing_keys=frozenset(getattr(belief, "rejected_listing_keys", []) or []),
        soft_prefs=tuple(
            (item.attr, item.direction, item.status, tuple(item.cues)) for item in belief.soft
        ),
        use_case=belief.use_case,
        price_sensitivity=getattr(belief, "price_sensitivity", None),
    )
