from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from backend.adapters.buywhere import AdapterError, BuyWhereClient

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"
SEARCH_URL = "https://api.buywhere.ai/v1/products/search"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_search_parses_real_fixture_and_sends_params():
    with respx.mock:
        route = respx.get(SEARCH_URL).mock(
            return_value=httpx.Response(200, json=_fixture("search_sony_keyword_us.json"))
        )
        client = BuyWhereClient(api_key="test")
        resp = client.search("sony wh1000xm5", country_code="US", mode="keyword", limit=5)

        assert len(resp.data) == 5
        assert resp.meta is not None and resp.meta.total == 6
        assert resp.meta.has_more is True
        # 真实响应结构：price 是嵌套对象，字段名 merchant 而非 domain
        assert resp.data[0].price.amount == 499.99
        assert resp.data[0].price.currency == "USD"
        assert resp.data[0].merchant == "shopify"
        # 认证与参数都真实发出
        sent = route.calls.last.request
        assert sent.headers["x-api-key"] == "test"
        params = sent.url.params
        assert params["q"] == "sony wh1000xm5"
        assert params["mode"] == "keyword"
        assert params["limit"] == "5"


def test_auth_error_mapping():
    with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(401, json={"error": "invalid_api_key"}))
        client = BuyWhereClient(api_key="wrong")
        with pytest.raises(AdapterError) as exc:
            client.search("q")
        assert exc.value.code == "auth_error"
        assert exc.value.retryable is False
        assert exc.value.category == "system"


def test_rate_limit_mapping():
    with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(429, json={}))
        client = BuyWhereClient(api_key="test")
        with pytest.raises(AdapterError) as exc:
            client.search("q")
        assert exc.value.code == "rate_limited"
        assert exc.value.retryable is True
        assert exc.value.category == "upstream"


def test_upstream_5xx_mapping():
    with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(503))
        client = BuyWhereClient(api_key="test")
        with pytest.raises(AdapterError) as exc:
            client.search("q")
        assert exc.value.code == "upstream_error"
        assert exc.value.retryable is True


def test_detail_returns_single_item_from_array():
    """实测 detail 端点返回 data 数组（非单对象），Adapter 取第一项。"""
    with respx.mock:
        respx.get("https://api.buywhere.ai/v1/products/91579391").mock(
            return_value=httpx.Response(200, json=_fixture("product_detail.json"))
        )
        client = BuyWhereClient(api_key="test")
        product = client.get_product("91579391")
        assert product is not None
        assert product.id == "91579391"
        assert product.price.amount == 19


def test_compare_returns_list():
    with respx.mock:
        route = respx.get("https://api.buywhere.ai/v1/products/compare").mock(
            return_value=httpx.Response(200, json=_fixture("search_sony_keyword_us.json"))
        )
        client = BuyWhereClient(api_key="test")
        items = client.compare(["a", "b"])
        assert len(items) == 5
        assert "ids" in route.calls.last.request.url.params
