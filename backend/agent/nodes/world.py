"""Apply dialogue effects and commit a single Goal-owned world transition."""
from __future__ import annotations

from typing import cast

from ...application.ports import ModelBackend
from ...application.services.world_route import finish_world_route
from ..state import MissionGraphState
from .decide import make_merge_mission_state
from .dialogue import apply_turn_effects, make_classify_dialogue_act
from .turn_actions import bind_turn_actions


def make_decide(model_backend: ModelBackend):
    return make_classify_dialogue_act(model_backend)


def _merge_updates(*parts: dict) -> dict:
    merged: dict = {}
    warnings: list[str] = []
    for part in parts:
        for key, value in part.items():
            if key == "warnings" and value:
                warnings.extend(value)
            else:
                merged[key] = value
    if warnings:
        merged["warnings"] = warnings
    return merged


async def apply_world_ops(
    state: MissionGraphState,
    *,
    enabled_item_types: frozenset[str] | None = None,
) -> dict:
    """Apply input adapters, reduce to Goal, then choose the next explicit graph branch."""
    updates: dict = {}
    current: dict = dict(state)
    for step in (
        bind_turn_actions,
        apply_turn_effects,
        make_merge_mission_state(enabled_item_types=enabled_item_types),
    ):
        part = await step(cast(MissionGraphState, current))
        updates = _merge_updates(updates, part)
        current.update(part)
    routed = finish_world_route(
        current.get("turn_plan"),
        mission=current["mission"],
        cache_payload=current.get("cache_payload"),
        skip_intent_patch=bool(current.get("skip_intent_patch")),
        constraints_before=current.get("constraints_before") or current["mission"].constraints,
        decided_route=current.get("decided_route"),
        requires_clarification=bool(current.get("requires_clarification")),
        clarification_question=current.get("clarification_question"),
    )
    return _merge_updates(updates, routed)
