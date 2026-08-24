"""阶段 1：口语一次决策。ground 不改 kind；并列 op 全部生效。"""
from __future__ import annotations

import pytest

from backend.agent.nodes.dialogue import make_classify_dialogue_act
from backend.agent.nodes.world import apply_world_ops
from backend.application.dto.dialogue import DialogueAct, DialogueActKind, TurnPlan, TurnRoute
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.dto.runner import IntentPatch
from backend.application.services.decide_oral import fold_constraint_patch
from backend.application.services.nlu import ground_dialogue_act
from tests.fakes import FakeModelBackend

OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def _mission(**kwargs) -> ShoppingMission:
    constraints = kwargs.pop(
        "constraints", MissionConstraints(query="降噪耳机", budget_cny=4000, markets=["US"])
    )
    return ShoppingMission(owner_id=OWNER, title="oral", constraints=constraints, **kwargs)


class _ScriptedDecision(FakeModelBackend):
    def __init__(self, plan: TurnPlan) -> None:
        super().__init__()
        self._plan = plan

    async def parse_decision(self, text, **kwargs):
        del text, kwargs
        return self._plan


def test_ground_does_not_cover_refine_with_stance_frame() -> None:
    act = DialogueAct(kind=DialogueActKind.REFINE, patch=IntentPatch(query="降噪耳机"))
    grounded = ground_dialogue_act(act, "太贵了", current_query="降噪耳机")
    assert grounded.kind == DialogueActKind.REFINE


def test_fold_constraint_patch_preserves_model_origin() -> None:
    plan = TurnPlan(
        ops=[
            DialogueAct(
                kind=DialogueActKind.REFINE,
                source="model",
                patch=IntentPatch(query="27 inch 4K monitor", source="model"),
            )
        ]
    )
    assert fold_constraint_patch(MissionConstraints(), plan).source == "model"


def test_ground_does_not_rewrite_ask_item_to_stock_filter() -> None:
    from backend.application.dto.dialogue import AskTopic

    act = DialogueAct(kind=DialogueActKind.ASK_ITEM, topic=AskTopic.STOCK)
    grounded = ground_dialogue_act(act, "只看有货", current_query="轻便徒步鞋")
    assert grounded.kind == DialogueActKind.ASK_ITEM


def test_ground_still_promotes_unknown_when_query_slot_fills() -> None:
    act = DialogueAct(
        kind=DialogueActKind.UNKNOWN,
        patch=IntentPatch(requires_clarification=True, clarification_question="您想买什么？"),
    )
    grounded = ground_dialogue_act(
        act, "帮我找一副适合通勤的降噪耳机，预算 2500 元以内"
    )
    assert grounded.kind == DialogueActKind.REFINE
    assert grounded.patch is not None
    assert "降噪耳机" in (grounded.patch.query or "")
    assert grounded.patch.budget_cny == 2500


def test_ground_still_fills_omitted_stance() -> None:
    act = DialogueAct(kind=DialogueActKind.STANCE, stance=None)
    grounded = ground_dialogue_act(act, "太贵了", current_query="降噪耳机")
    assert grounded.kind == DialogueActKind.STANCE
    assert grounded.stance == "too_expensive"


@pytest.mark.asyncio
async def test_model_ops_are_not_replaced_by_rule_plan() -> None:
    """模型出完整 ops；不再用规则 propose_plan 盖 lead。"""
    plan = TurnPlan(
        ops=[
            DialogueAct(kind=DialogueActKind.COMPARE, referent_ranks=[1, 2], source="model"),
            DialogueAct(kind=DialogueActKind.REJECT, exclude_terms=["入耳"], source="model"),
        ],
        lead=DialogueAct(kind=DialogueActKind.COMPARE, referent_ranks=[1, 2], source="model"),
    )
    backend = _ScriptedDecision(plan)
    state: dict = {
        "mission": _mission(),
        "run_id": "r-ops",
        "text": "帮我比前两个，不要入耳",
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
    kinds = [item.kind for item in state["turn_plan"].ops]
    assert DialogueActKind.COMPARE in kinds
    assert DialogueActKind.REJECT in kinds
    state.update(await apply_world_ops(state))
    assert "入耳" in state["mission"].constraints.excluded_terms
    assert state["turn_route"] == TurnRoute.REFILTER.value
    leftover_kinds = [item.kind for item in state["turn_plan"].leftover]
    assert DialogueActKind.COMPARE in leftover_kinds
