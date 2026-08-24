"""异步 SearchService 编排测试（应用层，fake Ports 注入）。

覆盖：端到端排序、预算过滤、汇率降级、无结果、多市场归并、部分市场失败、系统错误传播、无价格跳过。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.application.dto import ProductSearchResult
from backend.application.errors import UpstreamUnavailableError
from backend.application.services import SearchService
from backend.application.services.market_search import gather_market_products
from backend.domain.models import FxSnapshot, SearchMode, SearchParams
from backend.domain.policies.normalize import normalize_item
from backend.infrastructure.product_sources.buywhere import BuyWhereSearchResponse

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"


def _result_from_fixture(name: str) -> ProductSearchResult:
    body = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    resp = BuyWhereSearchResponse.model_validate(body)
    products = [normalize_item(i) for i in resp.data if i.price and i.price.amount]
    return ProductSearchResult(products=products)


class StubProducts:
    """async fake ProductSource：按市场返回预置结果，或对指定市场抛错。"""

    def __init__(self, by_market: dict, *, fail_system: set[str] | None = None) -> None:
        self.by_market = by_market
        self.fail_system = fail_system or set()
        self.calls: list[dict] = []

    async def search(
        self, query, *, country_code, mode="keyword", limit=20, max_price=None
    ) -> ProductSearchResult:
        self.calls.append(
            {
                "query": query,
                "country_code": country_code,
                "mode": mode,
                "limit": limit,
                "max_price": max_price,
            }
        )
        if country_code in self.fail_system:
            raise UpstreamUnavailableError(code="auth_error", category="system", retryable=False)
        return self.by_market.get(country_code, ProductSearchResult(products=[]))

    async def get_product(self, product_id):
        return None


class StubFx:
    """async fake FxSource：缺失或指定失败币种抛 UpstreamUnavailableError。"""

    def __init__(self, rates: dict[str, FxSnapshot] | None = None, fail: set[str] | None = None) -> None:
        self.rates = rates or {}
        self.fail = fail or set()

    async def get_rate(self, base, quote) -> FxSnapshot:
        if base in self.fail or base not in self.rates:
            raise UpstreamUnavailableError(code="fx_unavailable", category="upstream", retryable=True)
        return self.rates[base]


def _svc(bw: StubProducts, fx: StubFx | None = None) -> SearchService:
    return SearchService(products=bw, fx=fx or StubFx())


def _usd(rate: float = 6.7) -> FxSnapshot:
    return FxSnapshot(base="USD", quote="CNY", rate=rate, date="2026-08-14", source="frankfurter-ecb")


@pytest.mark.asyncio
async def test_end_to_end_rank_by_rmb_price() -> None:
    us = _result_from_fixture("search_sony_keyword_us.json")
    svc = _svc(StubProducts({"US": us}), StubFx({"USD": _usd()}))
    result = await svc.run(
        SearchParams(query="sony wh1000xm5", markets=["US"], mode=SearchMode.KEYWORD, limit=5)
    )
    assert len(result.products) == 5
    assert all(p.rmb_price is not None for p in result.products)
    assert result.products[0].rmb_price == pytest.approx(499.99 * 6.7)
    prices = [p.rmb_price for p in result.products]
    assert prices == sorted(prices)
    assert result.degraded is False
    assert [f.base for f in result.fx] == ["USD"]


@pytest.mark.asyncio
async def test_budget_filter_excludes_over() -> None:
    us = _result_from_fixture("search_sony_keyword_us.json")
    products = StubProducts({"US": us})
    svc = _svc(products, StubFx({"USD": _usd()}))
    result = await svc.run(SearchParams(query="q", markets=["US"], budget_cny=1000))
    # 499.99*6.7 ≈ 3350 > 1000，全部排除；无换算失败商品
    assert result.products == []
    assert any("超出预算" in w for w in result.warnings)
    assert products.calls[0]["max_price"] == pytest.approx(1000 / 6.7, rel=1e-4)


@pytest.mark.asyncio
async def test_fx_failure_degrades_but_keeps_products() -> None:
    us = _result_from_fixture("search_sony_keyword_us.json")
    svc = _svc(StubProducts({"US": us}), StubFx({"USD": _usd()}, fail={"USD"}))
    result = await svc.run(SearchParams(query="q", markets=["US"]))
    assert result.products  # 不丢结果
    assert all(p.fx_failed for p in result.products)
    assert result.degraded is True
    assert any("汇率不可用" in w for w in result.warnings)


@pytest.mark.asyncio
async def test_no_results_is_degraded() -> None:
    svc = _svc(StubProducts({"US": ProductSearchResult(products=[])}))
    result = await svc.run(SearchParams(query="nothing", markets=["US"]))
    assert result.products == []
    assert result.degraded is True


@pytest.mark.asyncio
async def test_search_execution_records_request_contract_and_query_fingerprints() -> None:
    source = StubProducts(
        {
            "US": ProductSearchResult(
                products=[],
                provider_contract_version="fixture-v1",
                contract_fingerprint="contract-sha",
            )
        }
    )
    outcome = await gather_market_products(
        source,
        query="  Sony   Headphones ",
        markets=["US"],
        mode="keyword",
        limit=7,
        goal_version=9,
    )
    execution = outcome.executions[0]
    assert execution.goal_version == 9
    assert execution.requested_params["q"] == "  Sony   Headphones "
    assert execution.requested_params["country_code"] == "US"
    assert execution.contract_fingerprint == "contract-sha"
    assert execution.query_fingerprint
    assert execution.response_meta == execution.page_meta.model_dump(mode="json")


@pytest.mark.asyncio
async def test_multi_market_collects_both() -> None:
    us = _result_from_fixture("search_sony_keyword_us.json")
    sg = _result_from_fixture("search_wireless_hybrid_us.json")
    svc = _svc(StubProducts({"US": us, "SG": sg}))
    result = await svc.run(SearchParams(query="q", markets=["US", "SG"]))
    assert len(result.products) == len(us.products) + len(sg.products)


@pytest.mark.asyncio
async def test_invalid_market_warned_and_ignored() -> None:
    us = _result_from_fixture("search_sony_keyword_us.json")
    svc = _svc(StubProducts({"US": us}))
    result = await svc.run(SearchParams(query="q", markets=["US", "XX"]))
    assert result.products
    assert any("无效市场" in w for w in result.warnings)


@pytest.mark.asyncio
async def test_partial_market_failure_keeps_others_and_degrades() -> None:
    """AC-006：US 失败（upstream）而 SG 成功 → 保留 SG 候选 + degraded + US 警告，不整轮失败。"""
    sg = _result_from_fixture("search_wireless_hybrid_us.json")

    class FailProducts(StubProducts):
        async def search(self, query, *, country_code, mode="keyword", limit=20, max_price=None):
            if country_code == "US":
                raise UpstreamUnavailableError(code="rate_limited", category="upstream", retryable=True)
            return await super().search(
                query, country_code=country_code, mode=mode, limit=limit, max_price=max_price
            )

    svc = _svc(FailProducts({"SG": sg}), StubFx({"USD": _usd()}))
    result = await svc.run(SearchParams(query="q", markets=["US", "SG"]))
    assert result.products  # SG 候选保留
    assert result.degraded is True
    assert any("US 搜索失败" in w for w in result.warnings)


@pytest.mark.asyncio
async def test_system_error_propagates() -> None:
    us = _result_from_fixture("search_sony_keyword_us.json")
    svc = _svc(StubProducts({"US": us}, fail_system={"US"}), StubFx({"USD": _usd()}))
    with pytest.raises(UpstreamUnavailableError) as exc:
        await svc.run(SearchParams(query="q", markets=["US"]))
    assert exc.value.code == "auth_error"


@pytest.mark.asyncio
async def test_no_price_skipped_warning() -> None:
    market = ProductSearchResult(products=[], skipped_no_price=2)
    svc = _svc(StubProducts({"US": market}))
    result = await svc.run(SearchParams(query="q", markets=["US"]))
    assert result.products == []
    assert any("跳过 2 件无价格商品" in w for w in result.warnings)
