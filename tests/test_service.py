from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.adapters.buywhere import BuyWhereSearchResponse
from backend.adapters.fx import FxError
from backend.domain.models import FxSnapshot, SearchMode, SearchParams
from backend.service import SearchService

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"


def _load(name: str) -> BuyWhereSearchResponse:
    return BuyWhereSearchResponse.model_validate(
        json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    )


class StubBuywhere:
    def __init__(self, by_market: dict[str, BuyWhereSearchResponse]) -> None:
        self.by_market = by_market
        self.calls: list[dict] = []

    def search(self, query, country_code, mode, limit, **kwargs):
        self.calls.append({"query": query, "country_code": country_code, "mode": mode, "limit": limit})
        return self.by_market.get(country_code, BuyWhereSearchResponse(data=[], meta=None))


class StubFx:
    def __init__(self, rates: dict[str, FxSnapshot] | None = None, fail: set[str] | None = None) -> None:
        self.rates = rates or {}
        self.fail = fail or set()

    def get_rate(self, base, quote):
        if base in self.fail:
            raise FxError(f"{base} unavailable in stub")
        snap = self.rates.get(base)
        if snap is None:
            raise FxError(f"{base} missing in stub")
        return snap


def _svc(bw: StubBuywhere, fx: StubFx | None = None) -> SearchService:
    return SearchService(buywhere=bw, fx=fx or StubFx())


def test_end_to_end_rank_by_rmb_price():
    us = _load("search_sony_keyword_us.json")
    svc = _svc(StubBuywhere({"US": us}), StubFx({"USD": FxSnapshot(base="USD", quote="CNY", rate=6.7, date="2026-08-14", source="frankfurter-ecb")}))
    result = svc.run(SearchParams(query="sony wh1000xm5", markets=["US"], mode=SearchMode.KEYWORD, limit=5))
    assert len(result.products) == 5
    # 所有商品都已换算人民币价
    assert all(p.rmb_price is not None for p in result.products)
    assert result.products[0].rmb_price == pytest.approx(499.99 * 6.7)
    # 排序升序
    prices = [p.rmb_price for p in result.products]
    assert prices == sorted(prices)
    assert result.degraded is False
    assert [f.base for f in result.fx] == ["USD"]


def test_budget_filter_excludes_over():
    us = _load("search_sony_keyword_us.json")
    svc = _svc(StubBuywhere({"US": us}), StubFx({"USD": FxSnapshot(base="USD", quote="CNY", rate=6.7, date="d", source="s")}))
    result = svc.run(SearchParams(query="q", markets=["US"], budget_cny=1000))
    # 499.99*6.7 ≈ 3350 > 1000，全部排除；无换算失败商品
    assert result.products == []
    assert any("超出预算" in w for w in result.warnings)


def test_fx_failure_degrades_but_keeps_products():
    us = _load("search_sony_keyword_us.json")
    svc = _svc(StubBuywhere({"US": us}), StubFx({"USD": FxSnapshot(base="USD", quote="CNY", rate=6.7, date="d", source="s")}, fail={"USD"}))
    result = svc.run(SearchParams(query="q", markets=["US"]))
    assert result.products  # 不丢结果
    assert all(p.fx_failed for p in result.products)
    assert result.degraded is True
    assert any("汇率不可用" in w for w in result.warnings)


def test_no_results_is_degraded():
    svc = _svc(StubBuywhere({"US": BuyWhereSearchResponse(data=[], meta=None)}))
    result = svc.run(SearchParams(query="nothing", markets=["US"]))
    assert result.products == []
    assert result.degraded is True


def test_multi_market_collects_both():
    us = _load("search_sony_keyword_us.json")
    sg = _load("search_wireless_hybrid_us.json")
    svc = _svc(StubBuywhere({"US": us, "SG": sg}))
    result = svc.run(SearchParams(query="q", markets=["US", "SG"]))
    assert len(result.products) == len(us.data) + len(sg.data)


def test_invalid_market_warned_and_ignored():
    us = _load("search_sony_keyword_us.json")
    svc = _svc(StubBuywhere({"US": us}))
    result = svc.run(SearchParams(query="q", markets=["US", "XX"]))
    assert result.products
    assert any("无效市场" in w for w in result.warnings)
