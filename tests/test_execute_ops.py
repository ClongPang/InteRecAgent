"""阶段 2：执行看世界变化，不再用 kind 查表得边。"""
from __future__ import annotations

import inspect

import pytest

from backend.agent.graph import NODE_NAMES, build_graph
from backend.agent.nodes.dialogue import make_classify_dialogue_act
from backend.application.dto.dialogue import DialogueAct, DialogueActKind, TurnPlan, TurnRoute
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.dto.runner import IntentPatch
from backend.agent.nodes.execute import apply_world_ops
from backend.application.services.execute_ops import route_after_world
from tests.fakes import FakeModelBackend
from tests.test_agent_graph import _NeverInvoked, _stub_uow_factory

OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def _mission(**kwargs) -> ShoppingMission:
    constraints = kwargs.pop(
        "constraints", MissionConstraints(query="降噪耳机", budget_cny=4000, markets=["US"])
    )
    return ShoppingMission(owner_id=OWNER, title="exec", constraints=constraints, **kwargs)


class _ScriptedDecision(FakeModelBackend):
    def __init__(self, plan: TurnPlan) -> None:
        super().__init__()
        self._plan = plan

    async def parse_decision(self, text, **kwargs):
        del text, kwargs
        return self._plan


def test_route_after_world_has_no_kind_parameter() -> None:
    assert "kind" not in inspect.signature(route_after_world).parameters


def test_world_route_talk_when_nothing_changed() -> None:
    assert (
        route_after_world(
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            constraints_changed=False,
            needs_filter=False,
            needs_rank=False,
            talk_only=True,
            want_lighter_only=False,
            skip_intent_patch=False,
            merchants=[],
            ranked=[{"snapshot_id": "s1"}],
            pool=[{"snapshot_id": "s1"}],
        )
        == TurnRoute.TALK
    )


def test_world_route_refilter_when_filter_changed_even_if_lead_was_talk() -> None:
    """lead 是提问也不谈：世界排除词变了，就本地滤。"""
    assert (
        route_after_world(
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            constraints_changed=True,
            needs_filter=True,
            needs_rank=False,
            talk_only=False,
            want_lighter_only=False,
            skip_intent_patch=False,
            merchants=[],
            ranked=[{"snapshot_id": "s1"}],
            pool=[{"snapshot_id": "s1"}],
        )
        == TurnRoute.REFILTER
    )


def test_world_route_rerank_when_only_stance_moved() -> None:
    assert (
        route_after_world(
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            constraints_changed=False,
            needs_filter=False,
            needs_rank=True,
            talk_only=False,
            want_lighter_only=False,
            skip_intent_patch=False,
            merchants=[],
            ranked=[{"snapshot_id": "s1"}],
            pool=[{"snapshot_id": "s1"}],
        )
        == TurnRoute.RERANK
    )


def test_world_route_clarify_without_query() -> None:
    assert (
        route_after_world(
            has_query=False,
            has_cache=False,
            reuse_matches=False,
            constraints_changed=False,
            needs_filter=False,
            needs_rank=False,
            talk_only=False,
            want_lighter_only=False,
            skip_intent_patch=False,
            merchants=[],
            ranked=[],
            pool=[],
        )
        == TurnRoute.CLARIFY
    )


def test_world_route_honors_channel_decided_route() -> None:
    assert (
        route_after_world(
            has_query=True,
            has_cache=True,
            reuse_matches=False,
            constraints_changed=True,
            needs_filter=True,
            needs_rank=False,
            talk_only=False,
            want_lighter_only=False,
            skip_intent_patch=True,
            merchants=[],
            ranked=[],
            pool=[],
            decided_route="research",
        )
        == TurnRoute.RESEARCH
    )


def test_outer_graph_is_receive_decide_execute_persist() -> None:
    graph = build_graph(
        products=_NeverInvoked(),
        fx=_NeverInvoked(),
        model_backend=_NeverInvoked(),
        uow_factory=_stub_uow_factory(),
    )
    nodes = set(graph.get_graph().nodes.keys())
    assert NODE_NAMES == (
        "receive_message",
        "decide",
        "execute_ops",
        "persist_decision_snapshot",
    )
    assert all(name in nodes for name in NODE_NAMES)
    assert "classify_dialogue_act" not in nodes
    assert "route_turn" not in nodes
    assert "bind_turn_actions" not in nodes
    edges = {(edge.source, edge.target) for edge in graph.get_graph().edges}
    assert ("receive_message", "decide") in edges
    assert ("decide", "execute_ops") in edges
    assert ("execute_ops", "persist_decision_snapshot") in edges


@pytest.mark.asyncio
async def test_ask_plus_exclude_refilters_because_world_changed() -> None:
    """kind 查表会把 ASK 焊死 talk；执行器看排除词已写入，走 refilter。"""
    plan = TurnPlan(
        ops=[
            DialogueAct(kind=DialogueActKind.ASK_ITEM, source="model"),
            DialogueAct(kind=DialogueActKind.REJECT, exclude_terms=["入耳"], source="model"),
        ],
        lead=DialogueAct(kind=DialogueActKind.ASK_ITEM, source="model"),
    )
    backend = _ScriptedDecision(plan)
    state: dict = {
        "mission": _mission(),
        "run_id": "r-ask-ex",
        "text": "这款怎么样，不要入耳",
        "skip_intent_patch": False,
        "cache_payload": {
            "ranked": [
                {"snapshot_id": "s1", "title": "头戴 A"},
                {"snapshot_id": "s2", "title": "入耳 B"},
            ],
            "reuse_key": {"query": "降噪耳机", "markets": ["US"], "budget_cny": 4000},
        },
        "turn_context": {},
        "events": [],
    }
    state.update(await make_classify_dialogue_act(backend)(state))
    state.update(await apply_world_ops(state))
    assert state["dialogue_act"].kind == DialogueActKind.ASK_ITEM
    assert "入耳" in state["mission"].constraints.excluded_terms
    assert state["turn_route"] == TurnRoute.REFILTER.value
    leftover_kinds = [item.kind for item in state["turn_plan"].leftover]
    assert DialogueActKind.ASK_ITEM in leftover_kinds


@pytest.mark.asyncio
async def test_ask_only_talks_because_world_did_not_change() -> None:
    plan = TurnPlan(
        ops=[DialogueAct(kind=DialogueActKind.ASK_ITEM, source="model")],
        lead=DialogueAct(kind=DialogueActKind.ASK_ITEM, source="model"),
    )
    backend = _ScriptedDecision(plan)
    state: dict = {
        "mission": _mission(),
        "run_id": "r-ask",
        "text": "这款保修吗",
        "skip_intent_patch": False,
        "cache_payload": {
            "ranked": [{"snapshot_id": "s1", "title": "头戴 A"}],
            "reuse_key": {"query": "降噪耳机", "markets": ["US"], "budget_cny": 4000},
        },
        "turn_context": {},
        "events": [],
    }
    state.update(await make_classify_dialogue_act(backend)(state))
    state.update(await apply_world_ops(state))
    assert state["turn_route"] == TurnRoute.TALK.value
    assert state["mission"].constraints.excluded_terms == []
