from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt

from ...application.dto import ProductSearchResult
from ...application.errors import UpstreamUnavailableError
from ...domain.models import NormalizedProduct
from ...domain.policies.normalize import normalize_item
from ..retry import is_retryable, retry_wait

API_BASE = "https://api.buywhere.ai"


class BuyWherePrice(BaseModel):
    # 实测存在 amount 为 null 的无价格商品，需容错
    amount: float | None = None
    currency: str | None = None


class BuyWhereAvailability(BaseModel):
    in_stock: bool | None = None
    status: str | None = None


class BuyWhereProduct(BaseModel):
    # 字段集来自真实 API 实测（2026-08-19 阶段 0），不是 OpenAPI 文档假设。
    id: str
    title: str
    price: BuyWherePrice | None = None
    merchant: str | None = None
    url: str | None = None
    image_url: str | None = None
    region: str | None = None
    country_code: str | None = None
    updated_at: str | None = None
    click_url: str | None = None
    affiliate_redirect_url: str | None = None
    has_affiliate_tracking: bool | None = None
    is_affiliate: bool | None = None
    affiliate_disclosure: str | None = None
    availability: BuyWhereAvailability | None = None
    url_last_checked_at: str | None = None
    metadata: Any = None


class BuyWhereMeta(BaseModel):
    total: int | None = None
    limit: int | None = None
    offset: int | None = None
    response_time_ms: int | None = None
    cached: bool | None = None
    has_more: bool | None = None
    hint: str | None = None


class BuyWhereSearchResponse(BaseModel):
    data: list[BuyWhereProduct] = []
    meta: BuyWhereMeta | None = None


class BuyWherePriceHistory(BaseModel):
    product_id: str | None = None
    title: str | None = None
    current_price: float | None = None
    currency: str | None = None
    history: list[Any] = []
    stats: Any = None


def _parse_retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


class BuyWhereProductSource:
    """BuyWhere REST 商品源（实现 ProductSource Port）。

    httpx.AsyncClient 连接复用 + tenacity 受限重试。原始响应只在适配器内出现，
    通过领域归一化策略转为 NormalizedProduct 后返回应用层。
    """

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 15.0,
        base_url: str = API_BASE,
        client: httpx.AsyncClient | None = None,
        max_retries: int = 3,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout
        self._base_url = base_url
        self._max_retries = max_retries
        # 可注入 client 便于测试；默认共享同一连接
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> BuyWhereProductSource:
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def _request(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"x-api-key": self._api_key, "Accept": "application/json"}
        async for attempt in AsyncRetrying(
            retry=retry_if_exception(is_retryable),
            wait=retry_wait,
            stop=stop_after_attempt(self._max_retries),
            reraise=True,
        ):
            with attempt:
                try:
                    resp = await self._client.get(
                        f"{self._base_url}{path}", params=params, headers=headers
                    )
                except httpx.HTTPError as exc:
                    raise UpstreamUnavailableError(
                        code="upstream_error",
                        category="upstream",
                        retryable=True,
                        user_message="无法连接 BuyWhere 服务",
                    ) from exc
                if resp.status_code == 401:
                    raise UpstreamUnavailableError(
                        code="auth_error", category="system", retryable=False, status_code=401
                    )
                if resp.status_code == 429:
                    raise UpstreamUnavailableError(
                        code="rate_limited",
                        category="upstream",
                        retryable=True,
                        status_code=429,
                        retry_after=_parse_retry_after(resp),
                        user_message="BuyWhere 限流，请稍后重试",
                    )
                if resp.status_code >= 500:
                    raise UpstreamUnavailableError(
                        code="upstream_error",
                        category="upstream",
                        retryable=True,
                        status_code=resp.status_code,
                    )
                if resp.status_code >= 400:
                    raise UpstreamUnavailableError(
                        code="invalid_request",
                        category="user",
                        retryable=False,
                        status_code=resp.status_code,
                    )
                try:
                    return resp.json()
                except ValueError as exc:
                    raise UpstreamUnavailableError(
                        code="parse_error", category="upstream", retryable=True
                    ) from exc

    async def search(
        self,
        query: str,
        country_code: str = "US",
        mode: str = "keyword",
        limit: int = 20,
    ) -> ProductSearchResult:
        params: dict[str, Any] = {
            "q": query,
            "country_code": country_code,
            "mode": mode,
            "limit": limit,
        }
        body = await self._request("/v1/products/search", params)
        resp = BuyWhereSearchResponse.model_validate(body)
        return _normalize_response(resp)

    async def get_product(self, product_id: str) -> NormalizedProduct | None:
        # 实测：detail 端点返回 {"data":[...]} 数组（非单对象）。
        body = await self._request(f"/v1/products/{product_id}")
        resp = BuyWhereSearchResponse.model_validate(body)
        if not resp.data:
            return None
        item = resp.data[0]
        if item.price is None or item.price.amount is None:
            return None
        return normalize_item(item)

    async def compare(self, ids: list[str]) -> list[BuyWhereProduct]:
        body = await self._request("/v1/products/compare", {"ids": ",".join(ids)})
        return BuyWhereSearchResponse.model_validate(body).data

    async def get_prices(self, product_id: str, days: int = 30) -> BuyWherePriceHistory:
        body = await self._request(f"/v1/products/{product_id}/prices", {"days": days})
        return BuyWherePriceHistory.model_validate(body.get("data", {}))


def _normalize_response(resp: BuyWhereSearchResponse) -> ProductSearchResult:
    """原始响应 → 归一化商品列表；无价格商品跳过并计数（不伪造 0 元）。"""
    products: list[NormalizedProduct] = []
    skipped = 0
    for item in resp.data:
        if item.price is None or item.price.amount is None:
            skipped += 1
            continue
        products.append(normalize_item(item))
    return ProductSearchResult(products=products, skipped_no_price=skipped)
