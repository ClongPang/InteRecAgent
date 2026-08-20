from __future__ import annotations

import pytest

from backend.domain.models import FxSnapshot, NormalizedProduct
from backend.domain.policies import (
    apply_budget_filter,
    apply_relevance_filter,
    apply_stock_filter,
    convert_products,
    dedupe_products,
    rank_products,
    score_and_rank,
)


def _product(id: str, amount: float, currency: str = "USD", title: str = "x") -> NormalizedProduct:
    return NormalizedProduct(
        id=id, title=title, merchant="m", country_code="US",
        native_price_amount=amount, native_currency=currency,
    )


def _snap(rate: float) -> FxSnapshot:
    return FxSnapshot(base="USD", quote="CNY", rate=rate, date="2026-08-14", source="frankfurter-ecb")


class TestConvert:
    def test_converts_when_rate_available(self):
        products = convert_products([_product("a", 100)], {"USD": _snap(6.7)})
        assert products[0].rmb_price == pytest.approx(670.0)
        assert products[0].fx_failed is False
        assert products[0].fx_as_of == "2026-08-14"

    def test_fails_when_currency_missing(self):
        products = convert_products([_product("a", 100, currency="CAD")], {})
        assert products[0].rmb_price is None
        assert products[0].fx_failed is True


class TestBudgetFilter:
    def test_splits_into_three_buckets(self):
        in_budget = _product("a", 100)  # 100*6.7=670
        over = _product("b", 500)  # 3350
        no_fx = _product("c", 100, currency="CAD")
        in_budget, over, no_fx = convert_products(
            [in_budget, over, no_fx], {"USD": _snap(6.7)}
        )
        kept, over_bucket, fx_failed = apply_budget_filter(
            [in_budget, over, no_fx], budget_cny=1000.0
        )
        assert [p.id for p in kept] == ["a"]
        assert [p.id for p in over_bucket] == ["b"]
        # 换算失败的商品不因预算排除（部分成功原则）
        assert [p.id for p in fx_failed] == ["c"]


class TestDedupe:
    def test_dedupes_same_merchant_and_normalized_title(self):
        a = _product("a", 100, title="Sony - WH-1000XM5 (Black)")
        b = _product("b", 100, title="Sony WH1000XM5 Black")  # 归一化后相同
        c = _product("c", 100, title="Sony WH-1000XM5 (Blue)")
        out = dedupe_products([a, b, c])
        assert [p.id for p in out] == ["a", "c"]


class TestRank:
    def test_orders_by_rmb_price_asc(self):
        a = convert_products([_product("cheap", 50), _product("mid", 200), _product("pricey", 400)], {"USD": _snap(6.7)})
        assert [p.id for p in rank_products(a)] == ["cheap", "mid", "pricey"]

    def test_fx_failed_last(self):
        products = convert_products(
            [_product("ok", 50), _product("no_fx", 50, currency="CAD")], {"USD": _snap(6.7)}
        )
        ranked = rank_products(products)
        assert ranked[-1].id == "no_fx"


class TestRelevanceFilter:
    def test_drops_off_category_cheapest_junk(self):
        journal = _product("j", 10, title="Blood Pressure Log Book Daily Journal")
        monitor = _product("m", 200, title="Dell 27 inch 4K UHD Monitor")
        kept, dropped = apply_relevance_filter([journal, monitor], "27 寸 4K 显示器")
        assert [p.id for p in kept] == ["m"]
        assert [p.id for p in dropped] == ["j"]

    def test_keeps_all_when_filter_would_empty(self):
        journal = _product("j", 10, title="Blood Pressure Log Book")
        kept, dropped = apply_relevance_filter([journal], "27 寸 4K 显示器")
        assert [p.id for p in kept] == ["j"]
        assert dropped == []


class TestStockFilter:
    def test_unknown_stock_does_not_drop_fixture_items(self):
        items = [_product("a", 10), _product("b", 20)]
        kept, out, unknown = apply_stock_filter(items)
        assert [p.id for p in kept] == ["a", "b"]
        assert out == [] and unknown == []

    def test_filters_only_when_facts_exist(self):
        items = [
            _product("a", 10).model_copy(update={"in_stock": True}),
            _product("b", 20).model_copy(update={"in_stock": False}),
            _product("c", 30),
        ]
        kept, out, unknown = apply_stock_filter(items)
        assert [p.id for p in kept] == ["a"]
        assert [p.id for p in out] == ["b"]
        assert [p.id for p in unknown] == ["c"]


class TestScore:
    def test_rejected_and_out_of_stock_rank_lower(self):
        cheap = _product("cheap", 50).model_copy(update={"rmb_price": 350, "in_stock": False})
        mid = _product("mid", 80).model_copy(update={"rmb_price": 560, "in_stock": True})
        ranked = score_and_rank([cheap, mid], budget_cny=1000, rejected_source_ids={"cheap"})
        assert [p.id for p in ranked] == ["mid", "cheap"]

    def test_noise_preference_lifts_title_cue(self):
        generic = _product("generic", 80, title="Generic Wired Earbuds").model_copy(update={"rmb_price": 800})
        sony = _product("sony", 200, title="Sony WH-1000XM5 Noise Cancelling").model_copy(
            update={"rmb_price": 2100}
        )
        lowest = score_and_rank([generic, sony], budget_cny=4000, preference="lowest")
        noise = score_and_rank([generic, sony], budget_cny=4000, preference="noise")
        assert [p.id for p in lowest][0] == "generic"
        assert [p.id for p in noise][0] == "sony"

    def test_price_sensitive_prefers_cheaper(self):
        cheap = _product("cheap", 80, title="Bose QC Ultra").model_copy(update={"rmb_price": 1800})
        pricey = _product("pricey", 200, title="Sony WH-1000XM5").model_copy(update={"rmb_price": 2800})
        ranked = score_and_rank(
            [pricey, cheap],
            budget_cny=4000,
            preference="balanced",
            price_sensitive=True,
        )
        assert [p.id for p in ranked][0] == "cheap"

    def test_unsupported_weight_does_not_change_order(self):
        a = _product("a", 80, title="Sony").model_copy(update={"rmb_price": 1800})
        b = _product("b", 90, title="Bose").model_copy(update={"rmb_price": 2000})
        base = [p.id for p in score_and_rank([a, b], budget_cny=4000)]
        soft = score_and_rank(
            [a, b],
            budget_cny=4000,
            soft_prefs=[("weight", "lower", "unsupported")],
        )
        assert [p.id for p in soft] == base

    def test_soft_pref_cues_match_cross_language(self):
        from backend.domain.policies.score import dimension_matches

        product = _product("wp", 100, title="Garmin Waterproof Diver Watch")
        # attr 是中文标签，命中靠 LLM 给出的英文 cues → 通用跨语言匹配
        assert dimension_matches(product, attr="防水", cues=["waterproof", "ip68"]) is True
        # 没有 cues 且标题里没有「防水」字面 → 不命中（不编造）
        assert dimension_matches(product, attr="防水", cues=[]) is False

    def test_open_soft_pref_lifts_matching_candidate(self):
        match = _product("m", 100, title="Garmin Waterproof Watch").model_copy(
            update={"rmb_price": 670}
        )
        other = _product("o", 100, title="Basic Analog Watch").model_copy(
            update={"rmb_price": 670}
        )
        ranked = score_and_rank(
            [other, match],
            budget_cny=4000,
            soft_prefs=[("防水", "higher", "active", ("waterproof",))],
        )
        # 同价位下，命中开放式软偏好（带 cues）的候选被抬到首位
        assert [p.id for p in ranked][0] == "m"
