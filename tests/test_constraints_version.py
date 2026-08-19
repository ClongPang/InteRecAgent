"""constraints_version 只随约束内容变化递增。"""
from __future__ import annotations

import pytest

from backend.agent.nodes.decide import make_merge_mission_state
from backend.application.dto import (
    IntentPatch,
    MissionConstraints,
    ShoppingMission,
    next_constraints_version,
)
from backend.application.dto.belief import SoftPref


def test_next_constraints_version_only_bumps_on_change() -> None:
    empty = MissionConstraints()
    filled = MissionConstraints(query="降噪耳机", budget_cny=4000)
    same = MissionConstraints(query="降噪耳机", budget_cny=4000)
    assert next_constraints_version(1, empty, filled) == 2
    assert next_constraints_version(2, filled, same) == 2
    assert next_constraints_version(2, filled, MissionConstraints(query="降噪耳机", budget_cny=3000)) == 3


@pytest.mark.asyncio
async def test_merge_mission_state_does_not_increment_version() -> None:
    mission = ShoppingMission(id="m1", owner_id="u1", title="t", constraints_version=1)
    state = {
        "mission": mission,
        "run_id": "r1",
        "intent_patch": IntentPatch(query="通勤降噪耳机", budget_cny=4000),
        "skip_intent_patch": False,
    }
    out = await make_merge_mission_state()(state)
    assert out["mission"].constraints_version == 1
    assert out["mission"].constraints.query == "通勤降噪耳机"
    assert out["mission"].constraints.budget_cny == 4000


@pytest.mark.asyncio
async def test_merge_folds_open_soft_prefs_into_belief() -> None:
    """LLM 产出的开放式软偏好经 merge 并入信念，供通用打分使用（§5.1）。"""
    mission = ShoppingMission(id="m2", owner_id="u1", title="t", constraints_version=1)
    state = {
        "mission": mission,
        "run_id": "r1",
        "intent_patch": IntentPatch(
            query="登山手表",
            soft_prefs=[SoftPref(attr="防水", direction="higher", cues=["waterproof", "ip68"])],
        ),
        "skip_intent_patch": False,
    }
    out = await make_merge_mission_state()(state)
    soft = out["mission"].belief.soft
    waterproof = next(item for item in soft if item.attr == "防水")
    assert waterproof.cues == ["waterproof", "ip68"]


@pytest.mark.asyncio
async def test_apply_turn_effects_records_belief_in_graph() -> None:
    """控制反转后信念副作用在图内落地（原属命令层 DialoguePolicy）。"""
    from backend.agent.nodes.dialogue import apply_turn_effects
    from backend.application.dto.dialogue import DialogueAct, DialogueActKind

    mission = ShoppingMission(
        owner_id="u1", title="t", constraints=MissionConstraints(query="降噪耳机", budget_cny=4000)
    )
    stance = await apply_turn_effects(
        {"mission": mission, "dialogue_act": DialogueAct(kind=DialogueActKind.STANCE, stance="too_expensive")}
    )
    assert stance["mission"].belief.price_sensitivity == "too_expensive"

    reject = await apply_turn_effects(
        {
            "mission": mission,
            "dialogue_act": DialogueAct(kind=DialogueActKind.REJECT, referent_ranks=[1]),
            "cache_payload": {"ranked": [{"snapshot_id": "snap-1"}]},
        }
    )
    assert "snap-1" in reject["mission"].belief.rejected_snapshot_ids
