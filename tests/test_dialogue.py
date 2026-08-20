"""对话行为分类、检索失效与线程投影。"""
from __future__ import annotations

from backend.application.dto.belief import PreferenceBelief, SoftPref
from backend.application.dto.dialogue import DialogueAct, DialogueActKind, TurnRoute
from backend.application.dto.mission import MissionConstraints, ShoppingMission, TurnPhase
from backend.application.dto.runner import IntentPatch
from backend.application.services.dialogue import (
    classify_turn,
    next_moves_for,
    plan_route,
    preview_turn,
    project_thread,
    resolve_referent_ids,
    search_reuse_key,
    summarize_constraint_change,
)
from backend.application.services.nlu import ground_dialogue_act
from backend.application.services.parse_intent import extract_query
from backend.application.services.policy import sanitize_constraints
from backend.domain.models import NormalizedProduct
from backend.domain.policies import apply_exclusion_filter
from tests.fakes import deterministic_turn


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


def test_search_reuse_key_includes_budget() -> None:
    a = MissionConstraints(query="耳机", budget_cny=4000, markets=["US"])
    b = MissionConstraints(query="耳机", budget_cny=2000, markets=["US"])
    assert search_reuse_key(a) != search_reuse_key(b)
    c = MissionConstraints(query="耳机", budget_cny=4000, markets=["SG"])
    assert search_reuse_key(a) != search_reuse_key(c)
    assert search_reuse_key(a)["budget_cny"] == 4000


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
    assert view.messages[1].citations[0].snapshot_id == "s1"
    assert view.messages[1].role == "agent"


def test_project_thread_maps_cancel_and_ignores_progress() -> None:
    view = project_thread(
        [
            {"sequence": 1, "event_type": "search.started", "payload": {"run_id": "r1"}},
            {"sequence": 2, "event_type": "products.received", "payload": {"run_id": "r1", "count": 3}},
            {"sequence": 3, "event_type": "run.cancelled", "payload": {"run_id": "r1"}},
        ]
    )
    assert [m.kind for m in view.messages] == ["warning"]
    assert "停止" in view.messages[0].text


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


def test_preview_budget_only_is_research() -> None:
    act = classify_turn("预算 2000 元")
    current = MissionConstraints(query="降噪耳机", budget_cny=4000)
    _route, phase = preview_turn(
        act=act,
        constraints=current,
        has_cache=True,
        cache_reuse_key=search_reuse_key(current),
    )
    assert _route == TurnRoute.RESEARCH
    assert phase == TurnPhase.RESEARCHING


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
    assert view.messages[1].kind == "recommendation"


def test_project_thread_keeps_one_reply_when_ready_and_agent_share_run() -> None:
    view = project_thread(
        [
            {
                "sequence": 1,
                "event_type": "recommendation.ready",
                "payload": {"run_id": "r1", "text": "推荐 A。", "count": 2},
            },
            {
                "sequence": 2,
                "event_type": "agent.message",
                "payload": {"run_id": "r1", "text": "推荐 A。", "snapshot_ids": ["s1"]},
            },
        ]
    )
    assert [item.kind for item in view.messages] == ["agent"]
    assert view.messages[0].text == "推荐 A。"


def test_same_run_folds_constraint_change_into_user() -> None:
    before = MissionConstraints(query="耳机", budget_cny=4000)
    after = MissionConstraints(query="耳机", budget_cny=2000)
    view = project_thread(
        [
            {
                "sequence": 1,
                "event_type": "message.received",
                "payload": {"run_id": "r1", "text": "太贵了", "constraints_version": 2},
            },
            {
                "sequence": 2,
                "event_type": "constraints.updated",
                "payload": {
                    "run_id": "r1",
                    "before": before.model_dump(mode="json"),
                    "after": after.model_dump(mode="json"),
                    "constraints_version": 3,
                },
            },
            {
                "sequence": 3,
                "event_type": "agent.message",
                "payload": {
                    "run_id": "r1",
                    "text": "已按更低预算重筛。",
                    "citations": [
                        {
                            "snapshot_id": "s1",
                            "role": "primary",
                            "title": "Sony WH-1000XM5",
                            "estimated_cny": 2100,
                            "market": "US",
                        }
                    ],
                },
            },
        ],
        has_query=True,
        has_candidates=True,
    )
    assert [m.kind for m in view.messages] == ["user", "agent"]
    assert view.messages[0].change is not None
    assert "2000" in view.messages[0].change.summary
    assert view.messages[1].citations[0].title == "Sony WH-1000XM5"
    assert any(move.text == "为什么推荐" for move in view.messages[1].next_moves)


def test_ground_recovers_wrapped_first_turn() -> None:
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
    assert grounded.patch.requires_clarification is False


def test_ground_does_not_rewrite_compare() -> None:
    act = DialogueAct(kind=DialogueActKind.COMPARE, referent_ranks=[1, 2])
    grounded = ground_dialogue_act(act, "帮我比前两个耳机", current_query="降噪耳机")
    assert grounded.kind == DialogueActKind.COMPARE
    assert grounded.patch is None


def test_ground_recovers_stance_when_model_returns_refine() -> None:
    act = DialogueAct(kind=DialogueActKind.REFINE, patch=IntentPatch(query="降噪耳机"))
    grounded = ground_dialogue_act(act, "太贵了", current_query="降噪耳机")
    assert grounded.kind == DialogueActKind.STANCE
    assert grounded.stance == "too_expensive"
    assert grounded.patch is None or grounded.patch.query is None


def test_leftover_does_not_overwrite_query() -> None:
    assert extract_query("太贵了", current_query="降噪耳机") is None
    assert extract_query("再便宜一点", current_query="降噪耳机") is None
    assert extract_query("适合远程办公的 27 寸 4K 显示器，3000 元以内") == "27 寸 4K 显示器"
    assert extract_query("帮我找一副适合通勤的降噪耳机，预算 2500 元以内") == "降噪耳机"
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


def test_stance_records_belief_without_budget_change() -> None:
    mission = ShoppingMission(
        owner_id="u1",
        title="t",
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    preview = deterministic_turn(
        mission,
        "太贵了",
        cache_payload={"ranked": [{"snapshot_id": "s1", "estimated_cny": {"amount": 2500}}],
                       "reuse_key": search_reuse_key(mission.constraints)},
    )
    assert preview.constraints.query == "降噪耳机"
    assert preview.constraints.budget_cny == 4000
    assert preview.route == "rerank"
    assert preview.belief.price_sensitivity == "too_expensive"
    assert preview.mission.dialogue.last_act == "express_stance"


def test_sanitize_unsupported_capabilities() -> None:
    before = MissionConstraints(query="显示器")
    after = MissionConstraints(query="显示器", only_in_stock=True, preference="noise")
    sanitized, warnings, replies = sanitize_constraints("显示器", before, after)
    assert sanitized.only_in_stock is True
    assert sanitized.preference == "balanced"
    assert warnings
    assert replies


def test_classify_reject_this_item_uses_rank() -> None:
    act = classify_turn("不要这款", current_query="降噪耳机")
    assert act.kind == DialogueActKind.REJECT
    assert act.referent_ranks == [1]
    assert act.exclude_terms == []


def test_reject_writes_belief_and_reranks() -> None:
    mission = ShoppingMission(
        owner_id="u1",
        title="t",
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    preview = deterministic_turn(
        mission,
        "不要这款",
        cache_payload={
            "ranked": [
                {
                    "snapshot_id": "snap-1",
                    "source_product_id": "src-red",
                    "title": "COWIN E7 Red",
                    "merchant": "shopify",
                    "estimated_cny": {"amount": 2100},
                }
            ],
            "reuse_key": search_reuse_key(mission.constraints),
        },
    )
    assert preview.route == "rerank"
    assert "snap-1" in preview.belief.rejected_snapshot_ids
    assert "src:src-red" in preview.belief.rejected_listing_keys
    assert "title:cowin e7 red|m:shopify" in preview.belief.rejected_listing_keys


def test_expensive_without_budget_reranks() -> None:
    mission = ShoppingMission(
        owner_id="u1",
        title="t",
        constraints=MissionConstraints(query="降噪耳机"),
    )
    preview = deterministic_turn(
        mission,
        "太贵了",
        cache_payload={"ranked": [{"snapshot_id": "snap-1", "estimated_cny": {"amount": 2500}}],
                       "reuse_key": search_reuse_key(mission.constraints)},
    )
    assert preview.constraints.query == "降噪耳机"
    assert preview.constraints.budget_cny is None
    assert preview.route == "rerank"
    assert preview.belief.price_sensitivity == "too_expensive"


def test_plan_route_reject_without_cache_researches_when_query_present() -> None:
    # 无候选可排除但已有 query：去检索补齐候选，而非空谈；无 query 才澄清。
    assert (
        plan_route(
            kind=DialogueActKind.REJECT,
            has_query=True,
            has_cache=False,
            reuse_matches=False,
            skip_intent_patch=False,
            constraints_changed=False,
        )
        == TurnRoute.RESEARCH
    )
    assert (
        plan_route(
            kind=DialogueActKind.REJECT,
            has_query=False,
            has_cache=False,
            reuse_matches=False,
            skip_intent_patch=False,
            constraints_changed=False,
        )
        == TurnRoute.CLARIFY
    )


def test_classify_correction_keeps_query_and_excludes_inear() -> None:
    act = classify_turn("不是入耳", current_query="通勤降噪耳机")
    assert act.kind == DialogueActKind.REFINE
    assert act.patch is not None
    assert act.patch.query == "通勤降噪耳机"
    assert "入耳" in (act.patch.exclude_terms or [])


def test_resolve_focus_falls_back_to_mentioned() -> None:
    assert resolve_referent_ids("刚才那个怎么样", [], mentioned_snapshot_ids=["snap-9"]) == ["snap-9"]


def test_belief_with_soft_prefs_merges_and_keeps_reserved() -> None:
    belief = PreferenceBelief().mark_price_stance("too_expensive")  # 已含 price 软偏好
    merged = belief.with_soft_prefs(
        [
            SoftPref(attr="防水", cues=["waterproof"]),
            SoftPref(attr="低延迟", cues=["low latency", "ms"]),
            SoftPref(attr="price", cues=["ignored"]),  # 保留通道，不应被 LLM 从这里改写
        ]
    )
    attrs = {item.attr for item in merged.soft}
    assert "防水" in attrs and "低延迟" in attrs
    price = next(item for item in merged.soft if item.attr == "price")
    assert price.cues == []  # 原 price 软偏好未被开放式维度覆盖
    # 同 attr 再次并入以最新覆盖
    again = merged.with_soft_prefs([SoftPref(attr="防水", cues=["ipx8"])])
    waterproof = next(item for item in again.soft if item.attr == "防水")
    assert waterproof.cues == ["ipx8"]


def test_next_moves_keep_budget_when_price_sensitive() -> None:
    moves = next_moves_for(
        kind="refine_constraints",
        topic=None,
        has_query=True,
        has_candidates=True,
        ranked=[
            {"snapshot_id": "a", "title": "A", "estimated_cny": {"amount": 200}},
            {"snapshot_id": "b", "title": "B", "estimated_cny": {"amount": 300}},
        ],
        belief=PreferenceBelief(price_sensitivity="too_expensive"),
        budget_cny=4000,
    )
    assert any(item.text.startswith("预算") for item in moves)


def test_plan_route_reject_and_stance_use_rerank() -> None:
    assert (
        plan_route(
            kind=DialogueActKind.REJECT,
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            skip_intent_patch=False,
            constraints_changed=False,
        )
        == TurnRoute.RERANK
    )
    assert (
        plan_route(
            kind=DialogueActKind.STANCE,
            has_query=True,
            has_cache=True,
            reuse_matches=True,
            skip_intent_patch=False,
            constraints_changed=True,
        )
        == TurnRoute.RERANK
    )


def test_next_moves_follow_candidate_gap() -> None:
    from backend.application.services.dialogue import next_moves_for

    moves = next_moves_for(
        kind=DialogueActKind.REFINE.value,
        topic=None,
        has_query=True,
        has_candidates=True,
        ranked=[
            {"title": "Sony WH-1000XM5", "brand": "Sony", "estimated_cny": {"amount": 2100}},
            {"title": "Bose QC Ultra", "brand": "Bose", "estimated_cny": {"amount": 2600}},
        ],
    )
    texts = [move.text for move in moves]
    labels = [move.label for move in moves]
    assert "为什么推荐" in texts
    assert any("不要Sony" in label or "不要索尼" in label for label in labels) or "不要Sony" in texts
    assert any("再便宜一点" in text or "再收" in label for text, label in zip(texts, labels, strict=False))
