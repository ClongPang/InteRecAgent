"""按已执行的世界变化选计算工具。不读 DialogueAct.kind 查表。"""
from __future__ import annotations

from ..dto.dialogue import DialogueActKind, TurnPlan, TurnRoute
from .decide_oral import constraint_ops, leftover_after_route
from .nlu import reuse_key_matches
from .route import escalate_empty_merchant_filter


_TALK = {
    DialogueActKind.ASK_ITEM,
    DialogueActKind.ASK_SET,
    DialogueActKind.COMPARE,
    DialogueActKind.META,
}


def world_flags(plan: TurnPlan | None, *, constraints_changed: bool) -> dict:
    ops = list(getattr(plan, "ops", None) or [])
    work = constraint_ops(plan) if plan is not None else []
    talk = [item for item in ops if item.kind in _TALK]
    rejects = [item for item in work if item.kind == DialogueActKind.REJECT]
    stances = [item for item in work if item.kind == DialogueActKind.STANCE]
    need_filter = bool(rejects) or constraints_changed
    need_rank = bool(stances) and not need_filter
    want_lighter_only = bool(stances) and all(
        item.stance == "want_lighter" for item in stances
    ) and not rejects and not constraints_changed
    return {
        "talk_only": bool(talk) and not work,
        "needs_filter": need_filter,
        "needs_rank": need_rank,
        "want_lighter_only": want_lighter_only,
    }


def route_after_world(
    *,
    has_query: bool,
    has_cache: bool,
    reuse_matches: bool,
    constraints_changed: bool,
    needs_filter: bool,
    needs_rank: bool,
    talk_only: bool,
    want_lighter_only: bool,
    skip_intent_patch: bool,
    merchants: list[str],
    ranked: list[dict],
    pool: list[dict],
    decided_route: str | None = None,
) -> TurnRoute:
    if decided_route:
        return TurnRoute(decided_route)
    if want_lighter_only:
        return TurnRoute.TALK
    if not has_query:
        return TurnRoute.CLARIFY
    if talk_only and not constraints_changed and not skip_intent_patch:
        return TurnRoute.TALK
    if needs_filter or (skip_intent_patch and constraints_changed):
        if has_cache and reuse_matches:
            return escalate_empty_merchant_filter(
                TurnRoute.REFILTER, merchants=merchants, ranked=ranked, pool=pool
            )
        return TurnRoute.RESEARCH
    if needs_rank and has_cache:
        return TurnRoute.RERANK
    if skip_intent_patch:
        if has_cache and reuse_matches:
            return escalate_empty_merchant_filter(
                TurnRoute.REFILTER, merchants=merchants, ranked=ranked, pool=pool
            )
        return TurnRoute.RESEARCH
    if has_cache and reuse_matches:
        return TurnRoute.TALK if not constraints_changed else TurnRoute.REFILTER
    return TurnRoute.RESEARCH


def finish_world_route(
    plan: TurnPlan | None,
    *,
    mission,
    cache_payload: dict | None,
    skip_intent_patch: bool,
    constraints_before,
    decided_route: str | None,
    requires_clarification: bool,
    clarification_question: str | None,
) -> dict:
    payload = cache_payload or {}
    has_cache = bool(payload.get("ranked"))
    reuse_matches = reuse_key_matches(mission.constraints, payload.get("reuse_key"))
    constraints_changed = constraints_before != mission.constraints
    flags = world_flags(plan, constraints_changed=constraints_changed)
    if requires_clarification and not mission.constraints.query:
        route = TurnRoute.CLARIFY
        result = {
            "turn_route": route.value,
            "requires_clarification": True,
            "clarification_question": clarification_question,
        }
    else:
        route = route_after_world(
            has_query=bool(mission.constraints.query),
            has_cache=has_cache,
            reuse_matches=reuse_matches,
            constraints_changed=constraints_changed,
            skip_intent_patch=skip_intent_patch,
            merchants=list(mission.constraints.merchants),
            ranked=list(payload.get("ranked") or []),
            pool=list(payload.get("pool") or payload.get("ranked") or []),
            decided_route=decided_route,
            **flags,
        )
        result = {
            "turn_route": route.value,
            "requires_clarification": route == TurnRoute.CLARIFY,
        }
    if plan is not None:
        result["turn_plan"] = leftover_after_route(plan, route)
    return result
