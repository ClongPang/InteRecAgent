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
    run_filter,
    run_rank,
)
from backend.application.services.rec.pipeline import MAX_RANKED_CANDIDATES
from backend.domain.models import NormalizedProduct


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
    from backend.domain.models import DEFAULT_MARKETS

    assert plan.markets == list(DEFAULT_MARKETS)


def test_search_plan_appends_use_case() -> None:
    mission = ShoppingMission(
        owner_id="u",
        title="t",
        constraints=MissionConstraints(query="27 寸 4K 显示器", budget_cny=3000),
        belief=PreferenceBelief(use_case="远程办公"),
    )
    plan = plan_search(rec_state_from_mission(mission))
    assert plan.query == "27 寸 4K 显示器 远程办公"


def test_search_plan_appends_merchant_filter() -> None:
    mission = ShoppingMission(
        owner_id="u",
        title="t",
        constraints=MissionConstraints(query="降噪耳机", merchants=["lazada"]),
    )
    plan = plan_search(rec_state_from_mission(mission))
    assert "lazada" in plan.query.lower()


def test_referent_hint_resolves_brand_and_cheapest() -> None:
    ranked = [
        {"snapshot_id": "s1", "title": "索尼 WH-1000XM5", "brand": "Sony", "estimated_cny": {"amount": 2500}},
        {"snapshot_id": "s2", "title": "Bose QC Ultra", "brand": "Bose", "estimated_cny": {"amount": 1900}},
    ]
    assert detect_referent_hint("那个索尼怎么样") == "token:索尼"
    assert resolve_referent_ids("那个索尼怎么样", ranked) == ["s1"]
    assert resolve_referent_ids("那个JBL怎么样", [{"snapshot_id": "j1", "title": "JBL Live 660NC"}]) == ["j1"]
    assert resolve_referent_ids("便宜那个", ranked) == ["s2"]
    assert resolve_referent_ids("刚才那个", ranked, focus_snapshot_id="s2") == ["s2"]


def test_talk_reply_uses_brand_referent() -> None:
    ranked = [
        {
            "snapshot_id": "s1",
            "title": "索尼 WH-1000XM5",
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
    assert "索尼" in reply.text
    assert reply.snapshot_ids == ["s1"]


def test_color_miss_does_not_leave_comparison_set() -> None:
    ranked = [
        {
            "snapshot_id": "s1",
            "title": "AOC U27G4 4K Black",
            "estimated_cny": {"amount": 726},
            "unavailable_fields": ["availability"],
            "decision_reasons": [],
        },
        {
            "snapshot_id": "s2",
            "title": "BENQ EX271U 4K Black",
            "estimated_cny": {"amount": 793},
            "unavailable_fields": ["availability"],
            "decision_reasons": [],
        },
        {
            "snapshot_id": "s3",
            "title": "LG UltraFine 4K White",
            "estimated_cny": {"amount": 974},
            "unavailable_fields": ["availability"],
            "decision_reasons": [],
        },
    ]
    reply = compose_talk_reply(
        act=classify_turn("白色那个怎么样", current_query="4K 显示器"),
        text="白色那个怎么样",
        ranked=ranked,
        constraints=MissionConstraints(query="4K 显示器", budget_cny=3000),
        comparison_records=ranked[:2],
    )
    assert reply.snapshot_ids == []
    assert "找不到" in reply.text or "对不上" in reply.text


def test_run_filter_honors_listing_keys_after_new_snapshots() -> None:
    red = NormalizedProduct(
        id="src-red",
        title="COWIN E7 Red",
        merchant="shopify",
        native_price_amount=47,
        native_currency="USD",
        rmb_price=317,
    )
    white = NormalizedProduct(
        id="src-white",
        title="COWIN E7 White",
        merchant="shopify",
        native_price_amount=47,
        native_currency="USD",
        rmb_price=317,
    )
    kept, warnings = run_filter(
        MissionConstraints(query="降噪耳机", budget_cny=2500),
        [red, white],
        rejected_snapshot_ids={"old-snap-red"},
        rejected_listing_keys={"src:src-red", "title:cowin e7 red|m:shopify"},
        snapshot_map={"src-red": "new-snap-red", "src-white": "new-snap-white"},
    )
    assert [item.id for item in kept] == ["src-white"]
    assert any("否定" in item for item in warnings)


def test_run_filter_keeps_matching_merchant() -> None:
    amazon = NormalizedProduct(
        id="a1",
        title="Space One",
        merchant="amazon.sg",
        native_price_amount=99,
        native_currency="SGD",
        rmb_price=520,
    )
    lazada = NormalizedProduct(
        id="l1",
        title="WH-1000XM5",
        merchant="lazada.sg",
        native_price_amount=299,
        native_currency="SGD",
        rmb_price=1600,
    )
    kept, warnings = run_filter(
        MissionConstraints(query="降噪耳机", merchants=["lazada"]),
        [amazon, lazada],
    )
    assert [item.id for item in kept] == ["l1"]
    assert any("商户" in item for item in warnings)


def test_run_filter_aligns_buywhere_duplicate_listing() -> None:
    click = (
        "https://buywhere.ai/api/click?url=https%3A%2F%2Fquadrastores.com%2Fproducts"
        "%2Fsamsung-27-inch-4k-60hz-ips-uhd-gaming-monitor-black-1"
        "&product_id=473734239&merchant=shopify_buy30620_stock"
    )
    twin = NormalizedProduct(
        id="564527982",
        title="SAMSUNG 27 Inch UHD 4K 60Hz IPS Gaming Monitor - Black",
        merchant="shopify",
        url=click.replace("473734239", "564527982").replace("shopify_buy30620_stock", "shopify"),
        click_url=click.replace("473734239", "564527982").replace("shopify_buy30620_stock", "shopify"),
        native_price_amount=90,
        native_currency="USD",
        rmb_price=605,
    )
    other = NormalizedProduct(
        id="aoc-1",
        title="AOC U27G4 27 Inch 4K UHD IPS Gaming Monitor - Black",
        merchant="shopify",
        native_price_amount=108,
        native_currency="USD",
        rmb_price=726,
    )
    kept, warnings = run_filter(
        MissionConstraints(query="27 寸 4K 显示器", budget_cny=3000),
        [twin, other],
        rejected_listing_keys={
            "src:473734239",
            f"url:{click}",
            "title:samsung 27 inch uhd 4k 60hz ips gaming monitor - black|m:shopify_buy30620_stock",
        },
    )
    assert [item.id for item in kept] == ["aoc-1"]
    assert any("否定" in item for item in warnings)


def test_run_filter_only_drops_confirmed_out_of_stock() -> None:
    known = NormalizedProduct(
        id="a", title="JLab Go Air Headphones", merchant="jlab",
        native_price_amount=99, native_currency="USD", rmb_price=700, in_stock=True,
    )
    unknown = NormalizedProduct(
        id="b", title="Decathlon Wireless Headphones", merchant="decathlon",
        native_price_amount=80, native_currency="USD", rmb_price=560,
    )
    gone = NormalizedProduct(
        id="c", title="Generic Wired Headphones", merchant="shop",
        native_price_amount=50, native_currency="USD", rmb_price=350, in_stock=False,
    )
    kept, warnings = run_filter(
        MissionConstraints(query="耳机", only_in_stock=True),
        [known, unknown, gone],
    )
    assert [item.id for item in kept] == ["a", "b"]
    assert any("无货" in item for item in warnings)
    assert any("仍列出" in item for item in warnings)


def test_run_rank_caps_visible_candidates() -> None:
    products = [
        NormalizedProduct(
            id=f"h{i}",
            title=f"Wireless Headphones {i}",
            merchant="m",
            native_price_amount=20 + i,
            native_currency="USD",
            rmb_price=140 + i * 10,
        )
        for i in range(15)
    ]
    ranked, warnings = run_rank(
        ShoppingMission(owner_id="u", title="t", constraints=MissionConstraints(query="耳机")),
        products,
    )
    assert len(ranked) == MAX_RANKED_CANDIDATES
    assert any("只保留排序前" in item for item in warnings)
