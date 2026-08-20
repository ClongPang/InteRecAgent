"""不确定升格与槽位消解（生产/评测共用 SlotId）。"""
from __future__ import annotations

from backend.application.dto.belief import PreferenceBelief
from backend.application.dto.dialogue import DialogueAct, DialogueActKind
from backend.application.dto.mission import MissionConstraints
from backend.application.dto.probe import SlotId
from backend.application.dto.runner import IntentPatch
from backend.application.services.uncertainty import (
    assess_uncertainty,
    resolve_probe_coverage,
    select_probe,
)


def _spread_ranked() -> list[dict]:
    return [
        {"snapshot_id": "a", "title": "Sony WH-1000XM5 头戴", "estimated_cny": {"amount": 900}},
        {"snapshot_id": "b", "title": "Bose QC Ultra 头戴", "estimated_cny": {"amount": 2100}},
        {"snapshot_id": "c", "title": "Sony WF earbuds 入耳", "estimated_cny": {"amount": 1200}},
        {"snapshot_id": "d", "title": "JBL Tune earbuds 入耳", "estimated_cny": {"amount": 4200}},
    ]


def test_missing_query_is_only_blocking_probe() -> None:
    probe = select_probe(
        constraints=MissionConstraints(),
        belief=PreferenceBelief(),
        ranked=_spread_ranked(),
    )
    assert probe is not None
    assert probe.slot == SlotId.QUERY
    assert probe.blocking is True


def test_budget_probe_when_spread_and_no_cap() -> None:
    probe = select_probe(
        constraints=MissionConstraints(query="降噪耳机"),
        belief=PreferenceBelief(),
        ranked=_spread_ranked(),
    )
    assert probe is not None
    assert probe.slot == SlotId.BUDGET
    assert probe.blocking is False
    assert any("预算" in item.text for item in probe.options)
    assert any("先不设预算" in item.text for item in probe.options)


def test_form_split_after_budget_known() -> None:
    probe = select_probe(
        constraints=MissionConstraints(query="耳机", budget_cny=3000),
        belief=PreferenceBelief(),
        ranked=_spread_ranked(),
    )
    assert probe is not None
    assert probe.slot == SlotId.SPLIT
    assert probe.split_key == "form"


def test_reject_reason_after_bare_reject() -> None:
    act = DialogueAct(kind=DialogueActKind.REJECT, referent_ranks=[1])
    probe = select_probe(
        constraints=MissionConstraints(query="耳机", budget_cny=3000),
        belief=PreferenceBelief(rejected_snapshot_ids=["a"]),
        ranked=_spread_ranked()[:2],
        last_act=act,
    )
    assert probe is not None
    assert probe.slot == SlotId.REJECT_REASON


def test_reject_reason_skipped_when_critique_has_reason() -> None:
    belief = PreferenceBelief(rejected_snapshot_ids=["a"]).reject("a", reason="price")
    probe = select_probe(
        constraints=MissionConstraints(query="耳机", budget_cny=3000),
        belief=belief,
        ranked=_spread_ranked()[:2],
        last_act=DialogueAct(kind=DialogueActKind.REJECT, referent_ranks=[1]),
    )
    assert probe is None or probe.slot != SlotId.REJECT_REASON
    pending = belief.model_copy(update={"pending_slot": "reject_reason", "asked_slots": ["reject_reason"]})
    updated = resolve_probe_coverage(
        pending,
        DialogueAct(kind=DialogueActKind.STANCE, stance="too_expensive"),
        before=MissionConstraints(query="耳机", budget_cny=3000),
        after=MissionConstraints(query="耳机", budget_cny=3000),
    )
    assert updated.pending_slot is None


def test_does_not_reask_skipped_budget() -> None:
    probe = select_probe(
        constraints=MissionConstraints(query="降噪耳机"),
        belief=PreferenceBelief(skipped_slots=["budget"]),
        ranked=_spread_ranked(),
    )
    assert probe is None or probe.slot != SlotId.BUDGET


def test_resolve_budget_from_patch() -> None:
    before = MissionConstraints(query="耳机")
    after = MissionConstraints(query="耳机", budget_cny=2500)
    belief = PreferenceBelief(pending_slot="budget", asked_slots=["budget"])
    updated = resolve_probe_coverage(
        belief,
        DialogueAct(kind=DialogueActKind.REFINE, patch=IntentPatch(budget_cny=2500)),
        before=before,
        after=after,
    )
    assert updated.pending_slot is None
    assert "budget" not in updated.skipped_slots


def test_skip_budget_when_user_moves_on() -> None:
    constraints = MissionConstraints(query="耳机")
    belief = PreferenceBelief(pending_slot="budget", asked_slots=["budget"])
    updated = resolve_probe_coverage(
        belief,
        DialogueAct(kind=DialogueActKind.REFINE, patch=IntentPatch(query="耳机")),
        before=constraints,
        after=constraints,
    )
    assert updated.pending_slot is None
    assert "budget" in updated.skipped_slots


def test_ask_item_does_not_skip_pending_probe() -> None:
    belief = PreferenceBelief(pending_slot="budget", asked_slots=["budget"])
    updated = resolve_probe_coverage(
        belief,
        DialogueAct(kind=DialogueActKind.ASK_ITEM),
        before=MissionConstraints(query="耳机"),
        after=MissionConstraints(query="耳机"),
    )
    assert updated.pending_slot == "budget"
    assert "budget" not in updated.skipped_slots


def test_assess_does_not_ask_unactionable_shipping() -> None:
    slots = {
        item.slot.value
        for item in assess_uncertainty(
            constraints=MissionConstraints(query="耳机"),
            belief=PreferenceBelief(),
            ranked=_spread_ranked(),
        )
    }
    assert "shipping" not in slots
    assert "warranty" not in slots
