"""口语撤销：开放说法必须打到与按钮同一执行器。

问题：词表漏召后 kind=undo 也不回滚。阶段 0 要求识别与生效共用 turn_actions。
"""
from __future__ import annotations

import pytest

from backend.agent.nodes.dialogue import (
    make_classify_dialogue_act,
    make_compose_grounded_reply,
)
from backend.agent.nodes.execute import apply_world_ops
from backend.application.dto.dialogue import DialogueAct, DialogueActKind, TurnRoute
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.dto.runner import IntentPatch
from backend.application.services.nlu import ground_dialogue_act
from backend.application.services.turn_actions import (
    NOTHING_TO_UNDO_MESSAGE,
    apply_undo_constraints,
    find_restorable_constraints,
    ledger_constraint_event,
    route_after_undo,
)
from tests.fakes import FakeModelBackend

OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def _mission(**kwargs) -> ShoppingMission:
    constraints = kwargs.pop("constraints", MissionConstraints(query="降噪耳机", budget_cny=4000))
    return ShoppingMission(owner_id=OWNER, title="undo", constraints=constraints, **kwargs)


def _updated(before: MissionConstraints, after: MissionConstraints) -> dict:
    return {
        "event_type": "constraints.updated",
        "payload": {
            "before": before.model_dump(mode="json"),
            "after": after.model_dump(mode="json"),
        },
    }


class _ScriptedTurn(FakeModelBackend):
    def __init__(self, act: DialogueAct) -> None:
        super().__init__()
        self._act = act

    async def parse_turn(self, text, **kwargs):
        del text, kwargs
        return self._act


def test_open_phrase_is_not_a_closed_class_hit() -> None:
    from backend.application.services.frames import is_undo_text

    assert is_undo_text("撤销刚才的条件")
    assert not is_undo_text("我反悔了")
    assert not is_undo_text("回到上一档预算")


def test_find_restorable_skips_empty_query_and_non_updates() -> None:
    empty = MissionConstraints(query="", budget_cny=1000)
    first = MissionConstraints(query="降噪耳机", budget_cny=2000)
    current = MissionConstraints(query="降噪耳机", budget_cny=4000)
    events = [
        _updated(empty, first),
        {"event_type": "message.received", "payload": {"text": "太贵了"}},
        _updated(first, current),
        {"event_type": "constraints.undo", "payload": {"restored": first.model_dump(mode="json")}},
    ]
    restored = find_restorable_constraints(events)
    assert restored == first


def test_find_restorable_none_when_ledger_empty() -> None:
    assert find_restorable_constraints([]) is None
    assert find_restorable_constraints([{"event_type": "message.received", "payload": {}}]) is None


def test_apply_undo_and_ledger_match_button_semantics() -> None:
    current = MissionConstraints(query="降噪耳机", budget_cny=4000)
    restored = MissionConstraints(query="降噪耳机", budget_cny=2000)
    mission = apply_undo_constraints(_mission(constraints=current), restored)
    assert mission.constraints == restored
    assert mission.dialogue.last_act == DialogueActKind.UNDO.value

    kind, payload = ledger_constraint_event(
        undo_applied=True, run_id="r1", before=current, after=restored, version=3
    )
    assert kind == "constraints.undo"
    assert payload["restored"]["budget_cny"] == 2000
    assert "before" not in payload

    kind, payload = ledger_constraint_event(
        undo_applied=False, run_id="r1", before=current, after=restored, version=3
    )
    assert kind == "constraints.updated"
    assert payload["before"]["budget_cny"] == 4000


def test_route_after_undo_prefers_refilter_when_cache_matches() -> None:
    current = MissionConstraints(query="降噪耳机", budget_cny=4000, markets=["US"])
    restored = MissionConstraints(query="降噪耳机", budget_cny=2000, markets=["US"])
    route, phase = route_after_undo(
        current=current,
        restored=restored,
        has_cache=True,
        cache_reuse_key={"query": "降噪耳机", "markets": ["US"], "budget_cny": 2000},
    )
    assert route == TurnRoute.REFILTER
    assert phase.value == "refiltering"


def test_ground_does_not_rewrite_model_undo() -> None:
    act = DialogueAct(kind=DialogueActKind.UNDO, source="model")
    grounded = ground_dialogue_act(act, "我反悔了", current_query="降噪耳机")
    assert grounded.kind == DialogueActKind.UNDO


@pytest.mark.asyncio
async def test_model_undo_on_open_phrase_restores_constraints() -> None:
    """词表未命中的「我反悔了」：模型标 undo 后必须回滚到上一笔 before。"""
    current = MissionConstraints(query="降噪耳机", budget_cny=4000, markets=["US"])
    previous = MissionConstraints(query="降噪耳机", budget_cny=2000, markets=["US"])
    backend = _ScriptedTurn(DialogueAct(kind=DialogueActKind.UNDO, source="model"))
    cache = {
        "ranked": [{"snapshot_id": "s1", "title": "WH-1000XM5", "estimated_cny": {"amount": 2500}}],
        "reuse_key": {"query": "降噪耳机", "markets": ["US"], "budget_cny": 2000},
    }
    state: dict = {
        "mission": _mission(constraints=current),
        "run_id": "r-oral",
        "text": "我反悔了",
        "skip_intent_patch": False,
        "cache_payload": cache,
        "turn_context": {},
        "events": [_updated(previous, current)],
    }
    state.update(await make_classify_dialogue_act(backend)(state))
    assert state["dialogue_act"].kind == DialogueActKind.UNDO
    state.update(await apply_world_ops(state))

    assert state["mission"].constraints.budget_cny == 2000
    assert state.get("undo_applied") is True
    assert state["turn_route"] == TurnRoute.REFILTER.value
    assert state.get("skip_intent_patch") is True


@pytest.mark.asyncio
async def test_model_undo_without_ledger_is_explicit_talk() -> None:
    backend = _ScriptedTurn(DialogueAct(kind=DialogueActKind.UNDO, source="model"))
    cache = {"ranked": [{"snapshot_id": "s1", "title": "WH-1000XM5"}]}
    state: dict = {
        "mission": _mission(),
        "run_id": "r-empty",
        "text": "回到上一档预算",
        "skip_intent_patch": False,
        "cache_payload": cache,
        "turn_context": {},
        "events": [],
    }
    state.update(await make_classify_dialogue_act(backend)(state))
    state.update(await apply_world_ops(state))
    reply = await make_compose_grounded_reply()(state)

    assert state["mission"].constraints.budget_cny == 4000
    assert not state.get("undo_applied")
    assert state["turn_route"] == TurnRoute.TALK.value
    assert reply["agent_message"] == NOTHING_TO_UNDO_MESSAGE
    assert reply["agent_act"] == DialogueActKind.UNDO.value


@pytest.mark.asyncio
async def test_refine_on_open_phrase_does_not_restore() -> None:
    current = MissionConstraints(query="降噪耳机", budget_cny=4000)
    previous = MissionConstraints(query="降噪耳机", budget_cny=2000)
    backend = _ScriptedTurn(
        DialogueAct(kind=DialogueActKind.REFINE, source="model", patch=IntentPatch())
    )
    state: dict = {
        "mission": _mission(constraints=current),
        "run_id": "r-refine",
        "text": "我反悔了",
        "skip_intent_patch": False,
        "cache_payload": {"ranked": [{"snapshot_id": "s1"}]},
        "turn_context": {},
        "events": [_updated(previous, current)],
    }
    state.update(await make_classify_dialogue_act(backend)(state))
    state.update(await apply_world_ops(state))
    assert state["mission"].constraints.budget_cny == 4000
    assert not state.get("undo_applied")
