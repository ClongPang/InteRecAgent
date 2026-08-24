from __future__ import annotations

import json
from pathlib import Path

from backend.application.dto import ShoppingMission
from tests.fakes import deterministic_turn

REPLAY = Path(__file__).with_name("trajectory_replay_v2.json")
CACHE = {
    "reuse_key": None,
    "ranked": [
        {
            "snapshot_id": "snapshot-1",
            "source_product_id": "provider-1",
            "title": "Sony Noise Cancelling Headphones",
            "merchant": "merchant",
            "market": "US",
            "native_price": {"amount": 299, "currency": "USD"},
            "estimated_cny": {"amount": 2100, "rate": 7, "source": "fixture", "rate_date": "2026-08-23"},
        }
    ],
}


def test_five_user_fourteen_turn_goal_replay_is_stable() -> None:
    payload = json.loads(REPLAY.read_text(encoding="utf-8"))
    assert len(payload["users"]) == 5
    assert sum(len(user["turns"]) for user in payload["users"]) == 14

    first_run: list[dict] = []
    for user in payload["users"]:
        mission = ShoppingMission(owner_id=user["user_id"], title="trajectory")
        for turn in user["turns"]:
            preview = deterministic_turn(
                mission,
                turn["text"],
                cache_payload=CACHE if turn.get("use_cache") else None,
            )
            mission = preview.mission
            expected = turn["expect"]
            if "item_type" in expected:
                assert mission.goal.target.item_type == expected["item_type"]
            if "brand" in expected:
                assert mission.goal.target.brand == expected["brand"]
            if "budget_cny" in expected:
                assert mission.constraints.budget_cny == expected["budget_cny"]
            if "markets" in expected:
                assert mission.goal.retrieval_scope.markets_requested == expected["markets"]
            if "relation" in expected:
                assert mission.goal.target.relation_required.value == expected["relation"]
            if "route" in expected:
                assert preview.route == expected["route"]
            first_run.append(mission.goal.model_dump(mode="json"))

    # The same fixture must reduce to the same Goal states on replay.
    second_run: list[dict] = []
    for user in payload["users"]:
        mission = ShoppingMission(owner_id=user["user_id"], title="trajectory")
        for turn in user["turns"]:
            preview = deterministic_turn(
                mission,
                turn["text"],
                cache_payload=CACHE if turn.get("use_cache") else None,
            )
            mission = preview.mission
            second_run.append(mission.goal.model_dump(mode="json"))
    assert second_run == first_run
