"""对话行为分类、检索失效与线程投影。"""
from __future__ import annotations

from backend.application.dto.dialogue import DialogueActKind, TurnCommand, TurnRoute
from backend.application.dto.mission import MissionConstraints, ShoppingMission, TurnPhase
from backend.application.services.dialogue import (
    classify_turn,
    plan_route,
    preview_turn,
    project_thread,
    search_reuse_key,
    summarize_constraint_change,
)
from backend.application.services.parse_intent import extract_query
from backend.application.services.policy import DialoguePolicy, TurnInput, sanitize_constraints
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
    assert ask.topic.value == "warranty"

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


def test_preview_question_is_responding_not_research() -> None:
    act = classify_turn("这款保修吗")
    _route, phase = preview_turn(
        act=act,
        constraints=MissionConstraints(query="降噪耳机"),
        has_cache=True,
        cache_reuse_key=search_reuse_key(MissionConstraints(query="降噪耳机")),
    )
    assert _route == TurnRoute.TALK
    assert phase == TurnPhase.RESPONDING


def test_preview_budget_only_is_refilter() -> None:
    act = classify_turn("预算 2000 元")
    current = MissionConstraints(query="降噪耳机", budget_cny=4000)
    _route, phase = preview_turn(
        act=act,
        constraints=current,
        has_cache=True,
        cache_reuse_key=search_reuse_key(current),
    )
    assert _route == TurnRoute.REFILTER
    assert phase == TurnPhase.REFILTERING


def test_summarize_and_project_constraint_change() -> None:
    before = MissionConstraints(query="耳机", budget_cny=4000)
    after = MissionConstraints(query="耳机", budget_cny=2000)
    assert "2000" in summarize_constraint_change(before, after)
    view = project_thread(
        [
            {
                "sequence": 1,
                "event_type": "constraints.updated",
                "payload": {
                    "run_id": "r1",
                    "before": before.model_dump(mode="json"),
                    "after": after.model_dump(mode="json"),
                    "constraints_version": 3,
                },
            },
            {
                "sequence": 2,
                "event_type": "recommendation.ready",
                "payload": {"run_id": "r9", "count": 3, "constraints_version": 3},
            },
        ]
    )
    assert view.messages[0].change_kind == "constraints"
    assert "2000" in view.messages[0].text
    assert view.messages[1].run_id == "r9"


def test_leftover_does_not_overwrite_query() -> None:
    assert extract_query("太贵了", current_query="降噪耳机") is None
    assert extract_query("再便宜一点", current_query="降噪耳机") is None
    act = classify_turn("太贵了", current_query="降噪耳机")
    assert act.kind == DialogueActKind.STANCE
    assert act.patch is None or act.patch.query is None


def test_search_reuse_key_ignores_stock() -> None:
    a = MissionConstraints(query="耳机", only_in_stock=True)
    b = MissionConstraints(query="耳机", only_in_stock=False)
    assert search_reuse_key(a) == search_reuse_key(b)


def test_stance_without_query_clarifies() -> None:
    assert (
        plan_route(
            kind=DialogueActKind.STANCE,
            has_query=False,
            has_cache=False,
            reuse_matches=False,
            skip_intent_patch=False,
            constraints_changed=False,
        )
        == TurnRoute.CLARIFY
    )


def test_policy_stance_tightens_existing_budget() -> None:
    mission = ShoppingMission(
        owner_id="u1",
        title="t",
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    decision = DialoguePolicy().decide(
        mission=mission,
        turn=TurnInput(command=TurnCommand.MESSAGE, text="太贵了"),
        has_cache=True,
        cache_reuse_key=search_reuse_key(mission.constraints),
    )
    assert decision.constraints.query == "降噪耳机"
    assert decision.constraints.budget_cny == 3200
    assert decision.apply_constraints is True
    assert decision.dispatch is True
    assert decision.route == TurnRoute.REFILTER


def test_sanitize_unsupported_capabilities() -> None:
    before = MissionConstraints(query="显示器")
    after = MissionConstraints(query="显示器", only_in_stock=True, preference="noise")
    sanitized, warnings, replies = sanitize_constraints("显示器", before, after)
    assert sanitized.only_in_stock is False
    assert sanitized.preference == "balanced"
    assert warnings
    assert replies
