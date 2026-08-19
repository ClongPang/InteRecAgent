"""对话式推荐：排序位移、检索计划、指代。"""
from __future__ import annotations

from backend.application.dto.belief import PreferenceBelief
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.grounded import compose_talk_reply
from backend.application.services.nlu import (
    classify_turn,
    detect_referent_hint,
    resolve_referent_ids,
)
from backend.application.services.rec import (
    looks_like_exact_model,
    plan_search,
    rec_state_from_mission,
)


def test_exact_model_is_precise_keyword() -> None:
    mission = ShoppingMission(
        owner_id="u",
        title="t",
        constraints=MissionConstraints(query="sony wh1000xm5"),
    )
    plan = plan_search(rec_state_from_mission(mission))
    assert plan.mode == "keyword"
    assert plan.recall_mode == "precise"
    assert looks_like_exact_model("通勤降噪耳机") is False


def test_chinese_exploratory_query_uses_hybrid() -> None:
    mission = ShoppingMission(
        owner_id="u",
        title="t",
        constraints=MissionConstraints(query="通勤降噪耳机"),
    )
    plan = plan_search(rec_state_from_mission(mission))
    assert plan.mode == "hybrid"
    assert plan.recall_mode == "exploratory"


def test_referent_hint_resolves_brand_and_cheapest() -> None:
    ranked = [
        {"snapshot_id": "s1", "title": "Sony WH-1000XM5", "brand": "Sony", "estimated_cny": {"amount": 2500}},
        {"snapshot_id": "s2", "title": "Bose QC Ultra", "brand": "Bose", "estimated_cny": {"amount": 1900}},
    ]
    assert detect_referent_hint("那个索尼怎么样") == "brand:sony"
    assert resolve_referent_ids("那个索尼怎么样", ranked) == ["s1"]
    assert resolve_referent_ids("便宜那个", ranked) == ["s2"]
    assert resolve_referent_ids("刚才那个", ranked, focus_snapshot_id="s2") == ["s2"]


def test_talk_reply_uses_brand_referent() -> None:
    ranked = [
        {
            "snapshot_id": "s1",
            "title": "Sony WH-1000XM5",
            "estimated_cny": {"amount": 2500},
            "unavailable_fields": ["availability"],
            "decision_reasons": [],
        },
        {
            "snapshot_id": "s2",
            "title": "Bose QC Ultra",
            "estimated_cny": {"amount": 1900},
            "unavailable_fields": ["availability"],
            "decision_reasons": [],
        },
    ]
    reply = compose_talk_reply(
        act=classify_turn("那个索尼怎么样", current_query="降噪耳机"),
        text="那个索尼怎么样",
        ranked=ranked,
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
        belief=PreferenceBelief(),
    )
    assert "Sony" in reply.text
    assert reply.snapshot_ids == ["s1"]
