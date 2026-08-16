"""BuyWhereProductSource 契约测试（真实响应 fixture + respx 拦截，无外网）。"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from backend.application.errors import UpstreamUnavailableError
from backend.infrastructure.product_sources.buywhere import BuyWhereProductSource

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"
SEARCH_URL = "https://api.buywhere.ai/v1/products/search"

pytestmark = [pytest.mark.contract, pytest.mark.asyncio]


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


async def test_search_parses_real_fixture_and_sends_params() -> None:
    with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_fixture("search_sony_keyword_us.json"))
        )
        async with BuyWhereProductSource(api_key="test") as src:
            result = await src.search("sony wh1000xm5", country_code="US", mode="keyword", limit=5)

        assert len(result.products) == 5
        assert result.skipped_no_price == 0
        assert result.products[0].native_price_amount == 499.99
        assert result.products[0].native_currency == "USD"
        assert result.products[0].merchant == "shopify"
        # 认证与参数都真实发出
        sent = route.calls.last.request
        assert sent.headers["x-api-key"] == "test"
        params = sent.url.params
        assert params["q"] == "sony wh1000xm5"
        assert params["mode"] == "keyword"
        assert params["limit"] == "5"


async def test_auth_error_mapping_no_retry() -> None:
    with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(401, json={"error": "invalid_api_key"})
        )
        async with BuyWhereProductSource(api_key="wrong") as src:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await src.search("q")
        assert exc.value.code == "auth_error"
        assert exc.value.retryable is False
        assert exc.value.category == "system"
        assert len(route.calls) == 1  # 401 不重试


async def test_rate_limit_retries_then_raises() -> None:
    with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(429, headers={"Retry-After": "0.05"}, json={})
        )
        async with BuyWhereProductSource(api_key="test") as src:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await src.search("q")
        assert exc.value.code == "rate_limited"
        assert exc.value.retryable is True
        assert exc.value.category == "upstream"
        assert len(route.calls) == 3  # 受限重试：max_retries=3


async def test_upstream_5xx_retries_then_raises() -> None:
    with respx.mock:
        route = respx.get(SEARCH_URL).mock(return_value=httpx.Response(503))
        async with BuyWhereProductSource(api_key="test") as src:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await src.search("q")
        assert exc.value.code == "upstream_error"
        assert exc.value.retryable is True
        assert len(route.calls) == 3


async def test_timeout_retries_then_raises() -> None:
    with respx.mock:
        route = respx.get(SEARCH_URL)
        route.side_effect = httpx.ConnectTimeout("connection timed out")
        async with BuyWhereProductSource(api_key="test", max_retries=2) as src:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await src.search("q")
        assert exc.value.code == "upstream_error"
        assert len(route.calls) == 2


async def test_no_price_products_skipped_and_counted() -> None:
    payload = {
        "data": [
            {"id": "a", "title": "no-price", "price": {"amount": None, "currency": "USD"}},
            {"id": "b", "title": "with-price", "price": {"amount": 19.0, "currency": "USD"}},
        ],
        "meta": None,
    }
    with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=payload))
        async with BuyWhereProductSource(api_key="test") as src:
            result = await src.search("q")
    assert len(result.products) == 1
    assert result.products[0].id == "b"
    assert result.skipped_no_price == 1


async def test_detail_returns_single_item_from_array() -> None:
    """实测 detail 端点返回 data 数组（非单对象），Adapter 取第一项。"""
    with respx.mock:
        respx.get("https://api.buywhere.ai/v1/products/91579391").mock(
            return_value=httpx.Response(200, json=_fixture("product_detail.json"))
        )
        async with BuyWhereProductSource(api_key="test") as src:
            product = await src.get_product("91579391")
        assert product is not None
        assert product.id == "91579391"
        assert product.native_price_amount == 19


async def test_compare_returns_list() -> None:
    with respx.mock:
        route = respx.get("https://api.buywhere.ai/v1/products/compare").mock(
            return_value=httpx.Response(200, json=_fixture("search_sony_keyword_us.json"))
        )
        async with BuyWhereProductSource(api_key="test") as src:
            items = await src.compare(["a", "b"])
        assert len(items) == 5
        assert "ids" in route.calls.last.request.url.params
