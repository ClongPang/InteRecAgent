"""话轮路由。Graph 只执行这里算出的 TurnRoute。"""
from __future__ import annotations

from ..dto.dialogue import DialogueAct, DialogueActKind, TurnRoute
from ..dto.mission import MissionConstraints, MissionStage, TurnPhase
from .nlu import preview_merged_constraints, reuse_key_matches


def plan_route(
    *,
    kind: DialogueActKind,
    has_query: bool,
    has_cache: bool,
    reuse_matches: bool,
    skip_intent_patch: bool,
    constraints_changed: bool,
) -> TurnRoute:
    if kind in {DialogueActKind.META, DialogueActKind.ASK_ITEM, DialogueActKind.COMPARE}:
        return TurnRoute.TALK
    if kind == DialogueActKind.STANCE and not constraints_changed:
        if has_cache:
            return TurnRoute.RERANK
        return TurnRoute.TALK if has_query else TurnRoute.CLARIFY
    if kind == DialogueActKind.REJECT:
        if has_cache:
            return TurnRoute.RERANK
        return TurnRoute.RESEARCH if has_query else TurnRoute.CLARIFY
    if kind == DialogueActKind.STANCE and constraints_changed and has_cache:
        return TurnRoute.RERANK
    if not has_query:
        return TurnRoute.CLARIFY
    if skip_intent_patch:
        if has_cache and reuse_matches:
            return TurnRoute.REFILTER
        return TurnRoute.RESEARCH
    if has_cache and reuse_matches:
        return TurnRoute.TALK if not constraints_changed else TurnRoute.REFILTER
    return TurnRoute.RESEARCH


def preview_turn(
    *,
    act: DialogueAct,
    constraints: MissionConstraints,
    has_cache: bool,
    cache_reuse_key: dict | None,
    skip_intent_patch: bool = False,
) -> tuple[TurnRoute, TurnPhase]:
    """在调度前决定本轮动作。talk/clarify 不得进入 researching。"""
    merged = constraints if skip_intent_patch else preview_merged_constraints(constraints, act)
    route = plan_route(
        kind=act.kind,
        has_query=bool(merged.query),
        has_cache=has_cache,
        reuse_matches=reuse_key_matches(merged, cache_reuse_key),
        skip_intent_patch=skip_intent_patch,
        constraints_changed=merged != constraints,
    )
    return route, phase_for_route(route)


def phase_for_route(route: TurnRoute) -> TurnPhase:
    if route == TurnRoute.RESEARCH:
        return TurnPhase.RESEARCHING
    if route in {TurnRoute.REFILTER, TurnRoute.RERANK}:
        return TurnPhase.REFILTERING
    return TurnPhase.RESPONDING


def stage_for_phase(phase: TurnPhase, current: MissionStage) -> MissionStage:
    if phase == TurnPhase.RESEARCHING:
        return MissionStage.SEARCHING
    if phase == TurnPhase.REFILTERING:
        return MissionStage.RANKING
    return current
