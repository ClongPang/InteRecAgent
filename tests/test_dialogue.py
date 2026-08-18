"""对话行为分类、检索失效与线程投影。"""
from __future__ import annotations

from backend.application.dto.dialogue import DialogueActKind, TurnRoute
from backend.application.dto.mission import MissionConstraints
from backend.application.services.dialogue import (
    classify_turn,
    plan_route,
    project_thread,
    search_reuse_key,
)
from backend.domain.policies import apply_exclusion_filter
from backend.domain.models import NormalizedProduct


def test_classify_refine_vs_talk_vs_reject() -> None:
    refine = classify_turn("通勤降噪耳机，预算 4000 元")
    assert refine.kind == DialogueActKind.REFINE
    assert refine.patch is not None
    assert refine.patch.query == "通勤降噪耳机"
    assert refine.patch.budget_cny == 4000

    ask = classify_turn("这款保修吗")
    assert ask.kind == DialogueActKind.ASK_ITEM
    assert ask.referent_ranks == [1]

    compare = classify_turn("帮我比前两个")
    assert compare.kind == DialogueActKind.COMPARE
    assert compare.referent_ranks == [1, 2]

    reject = classify_turn("不要索尼")
    assert reject.kind == DialogueActKind.REJECT
    assert reject.exclude_terms == ["索尼"]

    undo = classify_turn("撤销刚才的条件")
    assert undo.kind == DialogueActKind.UNDO


def test_plan_route_reuses_cache_for_budget_only() -> None:
    assert (
        plan_route(
            kind=DialogueActKind.REFINE,
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            skip_intent_patch=False,
            constraints_changed=True,
        )
        == TurnRoute.REFILTER
    )
    assert (
        plan_route(
            kind=DialogueActKind.REFINE,
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            skip_intent_patch=False,
            constraints_changed=False,
        )
        == TurnRoute.TALK
    )
    assert (
        plan_route(
            kind=DialogueActKind.REFINE,
            has_query=True,
            has_cache=False,
            reuse_matches=False,
            skip_intent_patch=False,
            constraints_changed=True,
        )
        == TurnRoute.RESEARCH
    )
    assert (
        plan_route(
            kind=DialogueActKind.ASK_ITEM,
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            skip_intent_patch=False,
            constraints_changed=False,
        )
        == TurnRoute.TALK
    )


def test_search_reuse_key_ignores_budget() -> None:
    a = MissionConstraints(query="耳机", budget_cny=4000, markets=["US"])
    b = MissionConstraints(query="耳机", budget_cny=2000, markets=["US"])
    assert search_reuse_key(a) == search_reuse_key(b)
    c = MissionConstraints(query="耳机", budget_cny=4000, markets=["SG"])
    assert search_reuse_key(a) != search_reuse_key(c)


def test_exclusion_filter_drops_title_matches() -> None:
    products = [
        NormalizedProduct(id="1", title="Sony WH-1000XM5", native_price_amount=1, native_currency="USD"),
        NormalizedProduct(id="2", title="Bose QC Ultra", native_price_amount=1, native_currency="USD"),
    ]
    kept, dropped = apply_exclusion_filter(products, ["索尼", "sony"])
    assert [p.id for p in kept] == ["2"]
    assert [p.id for p in dropped] == ["1"]


def test_project_thread_maps_user_and_agent_events() -> None:
    view = project_thread(
        [
            {
                "sequence": 1,
                "event_type": "message.received",
                "payload": {"text": "降噪耳机", "constraints_version": 1},
            },
            {
                "sequence": 2,
                "event_type": "agent.message",
                "payload": {"text": "首选是 Sony。", "constraints_version": 2, "snapshot_ids": ["s1"]},
            },
            {"sequence": 3, "event_type": "run.accepted", "payload": {}},
        ]
    )
    assert [m.kind for m in view.messages] == ["user", "agent"]
    assert view.messages[1].snapshot_ids == ["s1"]
