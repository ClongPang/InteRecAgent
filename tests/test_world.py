from backend.application.services.working_set import (
    WorkingSet,
    decision_quality,
    select_decision_set,
)
from backend.application.services.world import BindKind, World, bind_market


def test_bind_market_is_closed_schema() -> None:
    assert bind_market("美国") == "US"
    assert bind_market("lazada") is None
    assert bind_market("tokopedia") is None


def test_world_lookup_uses_current_titles() -> None:
    world = World.from_ranked(
        [
            {"snapshot_id": "s1", "title": "JBL Live 660NC", "merchant": "shopify"},
            {"snapshot_id": "s2", "title": "Space One", "merchant": "amazon.sg"},
        ]
    )
    assert world.lookup("jbl") == ("s1",)
    assert world.lookup("tokopedia") == ()
    assert world.bind_needle("美国").kind == BindKind.MARKET
    assert world.bind_needle("lazada").kind == BindKind.UNBOUND
    assert world.merchants == ("shopify", "amazon.sg")


def test_working_set_binds_pool_not_just_display() -> None:
    payload = {
        "ranked": [{"snapshot_id": "d1", "title": "Display One", "merchant": "amazon.sg"}],
        "pool": [
            {"snapshot_id": "d1", "title": "Display One", "merchant": "amazon.sg"},
            {"snapshot_id": "p2", "title": "Shopify ANC Headphones", "merchant": "shopify"},
        ],
    }
    working = WorkingSet.from_cache(payload)
    assert working.world().lookup("shopify") == ("p2",)
    assert [item["snapshot_id"] for item in working.display] == ["d1"]


def test_old_cache_without_pool_uses_ranked() -> None:
    working = WorkingSet.from_cache({"ranked": [{"snapshot_id": "s1", "title": "A"}]})
    assert [item["snapshot_id"] for item in working.bind_records] == ["s1"]


def test_decision_quality_needs_two_axes() -> None:
    same = [
        {
            "title": "Sony WH-1000XM5 头戴",
            "merchant": "amazon",
            "market": "US",
            "estimated_cny": 2100,
        },
        {
            "title": "Sony WH-CH720 头戴",
            "merchant": "amazon",
            "market": "US",
            "estimated_cny": 2200,
        },
    ]
    assert decision_quality(same).discriminable is False
    split = [
        {
            "title": "Sony WH-1000XM5 头戴",
            "merchant": "amazon",
            "market": "US",
            "estimated_cny": 2100,
        },
        {"title": "WF-1000XM5 入耳", "merchant": "lazada", "market": "SG", "estimated_cny": 1600},
    ]
    assert decision_quality(split).discriminable is True


def test_select_decision_set_does_not_pad() -> None:
    records = [
        {"snapshot_id": "a", "title": "头戴 A", "merchant": "amazon", "market": "US"},
        {"snapshot_id": "b", "title": "入耳 B", "merchant": "lazada", "market": "SG"},
    ]
    assert [item["snapshot_id"] for item in select_decision_set(records, limit=6)] == ["a", "b"]


def test_select_decision_set_collapses_color_only_variants() -> None:
    records = [
        {"snapshot_id": "w", "title": "JBL Tune 770 Headphones White", "merchant": "samsung"},
        {"snapshot_id": "b", "title": "JBL Tune 770 Headphones Black", "merchant": "samsung"},
        {"snapshot_id": "s", "title": "Sony WH-1000XM5 Headphones Black", "merchant": "lazada"},
    ]
    assert [item["snapshot_id"] for item in select_decision_set(records, limit=6)] == ["w", "s"]


def test_select_decision_set_reserves_market_diversity_before_merchants() -> None:
    records = [
        {
            "snapshot_id": f"sg-{index}",
            "title": f"Monitor {index}",
            "merchant": f"sg-{index}",
            "market": "SG",
        }
        for index in range(6)
    ] + [{"snapshot_id": "us", "title": "Monitor 0", "merchant": "bestbuy", "market": "US"}]
    selected = select_decision_set(records, limit=3)
    assert [item["market"] for item in selected] == ["SG", "US", "SG"]
