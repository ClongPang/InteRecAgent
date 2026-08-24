"""把任务约束与信念收成排序/检索共用的 RecState。"""

from __future__ import annotations

from dataclasses import dataclass

from ...dto.mission import ShoppingMission
from ..goal import constraint_view_from_goal, ensure_goal_authority


@dataclass(frozen=True)
class RecState:
    query: str | None
    item_type: str | None
    brand: str | None
    budget_cny: float | None
    markets: tuple[str, ...]
    preference: str
    only_in_stock: bool
    excluded_terms: tuple[str, ...]
    merchants: tuple[str, ...]
    rejected_snapshot_ids: frozenset[str]
    rejected_listing_keys: frozenset[str]
    soft_prefs: tuple[tuple[str, str, str, tuple[str, ...]], ...]
    use_case: str | None
    spec_gates: tuple[tuple[str, tuple[str, ...], bool], ...]
    price_sensitivity: str | None


def rec_state_from_mission(mission: ShoppingMission) -> RecState:
    goal = ensure_goal_authority(
        mission.goal,
        mission.constraints,
        version=max(mission.goal.goal_version, mission.constraints_version),
        belief=mission.belief,
    )
    constraints = constraint_view_from_goal(goal, fallback=mission.constraints)
    belief = mission.belief
    active_preferences = {item.facet: item for item in goal.preferences if item.status == "active"}
    goal_soft = [
        item.value
        for facet, item in active_preferences.items()
        if facet.startswith("soft_preference:") and isinstance(item.value, dict)
    ]
    goal_gates = [
        item.value
        for facet, item in active_preferences.items()
        if facet.startswith("spec_gate:") and isinstance(item.value, dict)
    ]
    goal_gates.extend(
        item.value
        for item in goal.constraints
        if item.status == "active"
        and item.facet.startswith("spec_gate:")
        and isinstance(item.value, dict)
    )
    soft_prefs = (
        tuple(
            (
                str(item.get("attr") or ""),
                str(item.get("direction") or "higher"),
                str(item.get("status") or "active"),
                tuple(str(cue) for cue in item.get("cues") or []),
            )
            for item in goal_soft
            if item.get("attr")
        )
        if goal_soft
        else tuple(
            (item.attr, item.direction, item.status, tuple(item.cues)) for item in belief.soft
        )
    )
    spec_gates = (
        tuple(
            (
                str(item.get("attr") or ""),
                tuple(str(cue) for cue in item.get("cues") or []),
                bool(item.get("required")),
            )
            for item in goal_gates
            if item.get("attr")
        )
        if goal_gates
        else tuple(
            (item.attr, tuple(item.cues), bool(item.required))
            for item in getattr(belief, "spec_gates", []) or []
        )
    )
    return RecState(
        query=constraints.query,
        item_type=goal.target.item_type,
        brand=goal.target.brand,
        budget_cny=constraints.budget_cny,
        markets=tuple(constraints.markets),
        preference=constraints.preference,
        only_in_stock=constraints.only_in_stock,
        excluded_terms=tuple(constraints.excluded_terms),
        merchants=tuple(constraints.merchants),
        rejected_snapshot_ids=frozenset(goal.rejected_values("snapshot")),
        rejected_listing_keys=frozenset(goal.rejected_values("listing")),
        soft_prefs=soft_prefs,
        use_case=str(active_preferences["use_case"].value)
        if "use_case" in active_preferences
        else belief.use_case,
        spec_gates=spec_gates,
        price_sensitivity=str(active_preferences["price_sensitivity"].value)
        if "price_sensitivity" in active_preferences
        else getattr(belief, "price_sensitivity", None),
    )
