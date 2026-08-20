"""模型视图：分类窗口、目录统计、起草切片。"""
from __future__ import annotations

from backend.application.dto.belief import PreferenceBelief, SpecGate
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.model_context import catalog_stats, draft_candidates, turn_view
from backend.application.services.parse_intent import extract_spec_gates, extract_use_case, parse_intent
from backend.application.services.policy import apply_act_effects
from backend.application.dto.dialogue import DialogueAct, DialogueActKind
from backend.domain.models import NormalizedProduct
from backend.domain.policies import apply_spec_gates


def test_extract_use_case_and_4k_gate() -> None:
    assert extract_use_case("适合远程办公的 27 寸 4K 显示器，3000 元以内") == "远程办公"
    assert extract_use_case("送给爸爸的轻便徒步鞋") == "送给爸爸"
    gates = extract_spec_gates("适合远程办公的 27 寸 4K 显示器")
    assert any(item.attr == "4k" and item.required for item in gates)
    patch = parse_intent("适合远程办公的 27 寸 4K 显示器，3000 元以内")
    assert patch.use_case == "远程办公"
    assert patch.query == "27 寸 4K 显示器"
    gift = parse_intent("送给爸爸的轻便徒步鞋，1000 元以内")
    assert gift.use_case == "送给爸爸"
    assert gift.query == "轻便徒步鞋"
    assert gift.budget_cny == 1000


def test_turn_view_projects_dst_not_full_belief() -> None:
    mission = ShoppingMission(
        owner_id="u",
        title="t",
        constraints=MissionConstraints(query="4K 显示器", budget_cny=3000),
        belief=PreferenceBelief(
            use_case="远程办公",
            spec_gates=[SpecGate(attr="4k", cues=["4k"], required=True)],
            rejected_listing_keys=["src:x"] * 3,
        ),
        comparison_snapshot_ids=["s2"],
    )
    view = turn_view(
        mission,
        {
            "ranked": [
                {"snapshot_id": "s1", "title": "A", "estimated_cny": {"amount": 900}},
                {"snapshot_id": "s2", "title": "B 4K", "estimated_cny": {"amount": 1200}},
            ]
        },
        [
            {"event_type": "message.received", "payload": {"text": "帮我比前两个"}},
            {"event_type": "agent.message", "payload": {"text": "按已记录事实对照：A 与 B。"}},
        ],
    )
    payload = view.as_classify_payload()
    assert "rejected_listing_keys" not in payload
    assert payload["dst"]["use_case"] == "远程办公"
    assert payload["dst"]["spec_gates"] == ["4k"]
    assert payload["comparison"][0]["title"] == "B 4K"
    assert payload["last_user"] == "帮我比前两个"
    assert payload["last_agent"]


def test_draft_candidates_keeps_compare_set() -> None:
    ranked = [
        NormalizedProduct(id="a", title="A", native_price_amount=1, native_currency="USD"),
        NormalizedProduct(id="b", title="B", native_price_amount=1, native_currency="USD"),
        NormalizedProduct(id="c", title="C", native_price_amount=1, native_currency="USD"),
        NormalizedProduct(id="d", title="D", native_price_amount=1, native_currency="USD"),
    ]
    picked = draft_candidates(ranked, compare_ids=["d"])
    assert [item.id for item in picked] == ["a", "b", "c", "d"]


def test_spec_gate_drops_off_spec_when_alternatives_exist() -> None:
    fhd = NormalizedProduct(id="f", title="27 Inch FHD Office Monitor", native_price_amount=1, native_currency="USD")
    uhd = NormalizedProduct(id="u", title="27 Inch 4K UHD Monitor", native_price_amount=1, native_currency="USD")
    kept, dropped = apply_spec_gates([fhd, uhd], [SpecGate(attr="4k", cues=["4k", "2160", "uhd"], required=True)])
    assert [item.id for item in kept] == ["u"]
    assert [item.id for item in dropped] == ["f"]


def test_catalog_stats_reports_gate_hits() -> None:
    products = [
        NormalizedProduct(id="1", title="4K Monitor", native_price_amount=1, native_currency="USD", rmb_price=1000),
        NormalizedProduct(id="2", title="FHD Monitor", native_price_amount=1, native_currency="USD", rmb_price=800),
    ]
    stats = catalog_stats(products, gates=[SpecGate(attr="4k", cues=["4k"], required=True)])
    assert stats.kept == 2
    assert stats.gate_hits["4k"] == 1
    assert stats.clusters.get("4k") == 1
    assert stats.clusters.get("monitor") == 1


def test_reject_then_expensive_annotates_reason() -> None:
    mission = ShoppingMission(owner_id="u", title="t", constraints=MissionConstraints(query="耳机"))
    belief, _ = apply_act_effects(
        mission.belief,
        mission.dialogue,
        DialogueAct(kind=DialogueActKind.REJECT, referent_ranks=[1]),
        cache_payload={"ranked": [{"snapshot_id": "s1", "title": "Red", "source_product_id": "src-1"}]},
    )
    assert belief.last_reject_reason() == "unknown"
    belief, _ = apply_act_effects(
        belief,
        mission.dialogue,
        DialogueAct(kind=DialogueActKind.STANCE, stance="too_expensive"),
    )
    assert belief.last_reject_reason() == "price"
    assert belief.price_sensitivity == "too_expensive"
