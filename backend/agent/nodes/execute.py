"""decide + execute_ops：一次决策，再按世界变化调用计算工具。"""
from __future__ import annotations

from collections.abc import Callable

from ...application.ports import FxSource, ModelBackend, ProductSource, RunTextHub, UnitOfWork
from ...application.services.execute_ops import finish_world_route
from ...application.services.uncertainty import choose_probe
from ..state import MissionGraphState
from .decide import make_filter_hard_constraints, make_merge_mission_state, make_rank_candidates
from .dialogue import (
    apply_turn_effects,
    make_classify_dialogue_act,
    make_compose_grounded_reply,
    make_load_cached_candidates,
)
from .evidence import make_compose_recommendation, make_verify_evidence
from .research import make_research
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


async def apply_world_ops(state: MissionGraphState) -> dict:
    """undo / 信念 / 约束合并 / 按世界选路。不调度 research/talk 实现。"""
    updates: dict = {}
    current: dict = dict(state)
    for step in (bind_turn_actions, apply_turn_effects, make_merge_mission_state()):
        part = await step(current)
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


def make_execute_ops(
    products: ProductSource,
    fx: FxSource,
    model_backend: ModelBackend,
    uow_factory: Callable[[], UnitOfWork],
    *,
    max_concurrency: int = 3,
    text_hub: RunTextHub | None = None,
):
    del text_hub
    load_cached = make_load_cached_candidates()
    compose_talk = make_compose_grounded_reply()
    research = make_research(products, fx, model_backend, uow_factory, max_concurrency)
    filter_hard = make_filter_hard_constraints()
    rank = make_rank_candidates()
    verify = make_verify_evidence()
    compose_rec = make_compose_recommendation(model_backend)

    async def _run_ready(current: dict) -> dict:
        verified = await verify(current)
        current.update(verified)
        drafted = await compose_rec(current)
        return _merge_updates(verified, drafted)

    async def _with_probe(current: dict, updates: dict) -> dict:
        mission = current["mission"]
        ranked = current.get("ranked") or list((current.get("cache_payload") or {}).get("ranked") or [])
        probe = await choose_probe(
            constraints=mission.constraints,
            belief=mission.belief,
            ranked=ranked,
            last_act=current.get("dialogue_act"),
            backend=model_backend,
        )
        if probe is None:
            return updates
        return _merge_updates(updates, {"probe": probe})

    async def execute_ops(state: MissionGraphState) -> dict:
        world = await apply_world_ops(state)
        current: dict = {**state, **world}
        route = current.get("turn_route") or "research"
        if route == "clarify":
            return await _with_probe(current, world)
        if route == "talk":
            loaded = await load_cached(current)
            current.update(loaded)
            talked = await compose_talk(current)
            current.update(talked)
            return await _with_probe(current, _merge_updates(world, loaded, talked))
        if route == "research":
            researched = await research(current)
            current.update(researched)
            ready = await _run_ready(current)
            current.update(ready)
            return await _with_probe(current, _merge_updates(world, researched, ready))
        loaded = await load_cached(current)
        current.update(loaded)
        filtered: dict = {}
        if route == "refilter":
            filtered = await filter_hard(current)
            current.update(filtered)
        ranked = await rank(current)
        current.update(ranked)
        ready = await _run_ready(current)
        current.update(ready)
        return await _with_probe(current, _merge_updates(world, loaded, filtered, ranked, ready))

    return execute_ops
