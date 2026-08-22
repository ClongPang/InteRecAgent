"""阶段 3：问与答跟问题和 CitedFacts 走，不默认概述第一件。"""
from __future__ import annotations

import pytest

from backend.application.dto.belief import PreferenceBelief
from backend.application.dto.dialogue import DialogueAct, DialogueActKind
from backend.application.dto.mission import MissionConstraints
from backend.application.dto.probe import SlotId
from backend.application.dto.runner import RecommendationDraft
from backend.application.errors import ModelUnavailableError
from backend.application.services.dialogue import classify_turn
from backend.application.services.grounded import compose_ready_reply, compose_talk_reply
from backend.application.services.uncertainty import choose_probe
from tests.fakes import FakeModelBackend
from tests.test_grounded import _ranked


def test_open_worth_question_does_not_overview_first_item() -> None:
    reply = compose_talk_reply(
        act=classify_turn("这款值不值得", current_query="降噪耳机"),
        text="这款值不值得",
        ranked=_ranked(),
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    assert "值不值得" in reply.text or "不能回答" in reply.text or "没有能回答" in reply.text
    assert "判断好坏" not in reply.text
    assert "4.8" not in reply.text
    assert "保修一年" not in reply.text


def test_authenticity_question_says_facts_are_missing() -> None:
    reply = compose_talk_reply(
        act=classify_turn("这款会不会是假货", current_query="降噪耳机"),
        text="这款会不会是假货",
        ranked=_ranked(),
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    assert "假货" in reply.text or "正品" in reply.text or "没有能回答" in reply.text
    assert "判断好坏" not in reply.text


def test_explicit_overview_still_introduces_the_item() -> None:
    reply = compose_talk_reply(
        act=classify_turn("这款怎么样", current_query="降噪耳机"),
        text="这款怎么样",
        ranked=_ranked(),
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    assert "Sony WH-1000XM5" in reply.text
    assert "2100" in reply.text


def test_ready_reply_uses_draft_rationale_and_primary() -> None:
    draft = RecommendationDraft(
        primary_snapshot_id="s2",
        alternative_snapshot_ids=["s1"],
        rationale=["商品价估算 2600 元在预算 4000 元内"],
        tradeoffs=["库存/规格信息未提供，需要到商户页确认"],
        cited_evidence_ids=["s2", "s1"],
    )
    text = compose_ready_reply(
        _ranked(),
        MissionConstraints(query="降噪耳机", budget_cny=4000),
        draft=draft,
    )
    assert "Bose QC Ultra" in text
    assert "2600" in text
    assert "商品价估算 2600" in text
    assert text.index("Bose") < text.index("Sony") if "Sony" in text else True


def test_ready_reply_without_draft_still_cites_facts() -> None:
    text = compose_ready_reply(_ranked(), MissionConstraints(query="降噪耳机", budget_cny=4000))
    assert "Sony WH-1000XM5" in text
    assert "2100" in text


class _PickSlot(FakeModelBackend):
    def __init__(self, slot: SlotId | str) -> None:
        super().__init__()
        self._slot = slot

    async def pick_probe(self, uncertainties):
        del uncertainties
        return self._slot


def _spread() -> list[dict]:
    return [
        {"snapshot_id": "a", "title": "Sony WH-1000XM5 头戴", "estimated_cny": {"amount": 900}},
        {"snapshot_id": "b", "title": "Bose QC Ultra 头戴", "estimated_cny": {"amount": 2100}},
        {"snapshot_id": "c", "title": "Sony WF earbuds 入耳", "estimated_cny": {"amount": 1200}},
        {"snapshot_id": "d", "title": "JBL Tune earbuds 入耳", "estimated_cny": {"amount": 4200}},
    ]


@pytest.mark.asyncio
async def test_choose_probe_lets_model_pick_from_closed_slots() -> None:
    probe = await choose_probe(
        constraints=MissionConstraints(query="耳机", budget_cny=3000),
        belief=PreferenceBelief(),
        ranked=_spread(),
        last_act=DialogueAct(kind=DialogueActKind.REFINE),
        backend=_PickSlot(SlotId.SPLIT),
    )
    assert probe is not None
    assert probe.slot == SlotId.SPLIT


@pytest.mark.asyncio
async def test_choose_probe_rejects_slot_outside_uncertainty() -> None:
    probe = await choose_probe(
        constraints=MissionConstraints(query="降噪耳机"),
        belief=PreferenceBelief(),
        ranked=_spread(),
        backend=_PickSlot("shipping"),
    )
    assert probe is not None
    assert probe.slot != "shipping"
    assert probe.slot in {SlotId.BUDGET, SlotId.SPLIT}


@pytest.mark.asyncio
async def test_choose_probe_cannot_skip_query_when_missing() -> None:
    probe = await choose_probe(
        constraints=MissionConstraints(),
        belief=PreferenceBelief(),
        ranked=_spread(),
        backend=_PickSlot(SlotId.BUDGET),
    )
    assert probe is not None
    assert probe.slot == SlotId.QUERY
    assert probe.blocking is True


@pytest.mark.asyncio
async def test_choose_probe_falls_back_when_model_unavailable() -> None:
    class _Down(FakeModelBackend):
        async def pick_probe(self, uncertainties):
            del uncertainties
            raise ModelUnavailableError("down")

    probe = await choose_probe(
        constraints=MissionConstraints(query="降噪耳机"),
        belief=PreferenceBelief(),
        ranked=_spread(),
        backend=_Down(),
    )
    assert probe is not None
    assert probe.slot == SlotId.BUDGET
