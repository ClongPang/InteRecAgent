"""constraints_version 只随约束内容变化递增。"""
from __future__ import annotations

import pytest

from backend.agent.nodes.decide import make_merge_mission_state
from backend.application.dto import IntentPatch, MissionConstraints, ShoppingMission, next_constraints_version


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
