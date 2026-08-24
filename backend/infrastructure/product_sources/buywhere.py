from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from pydantic import BaseModel
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt

from ...application.dto import ProductObservation, ProductSearchResult, SearchPageMeta
from ...application.errors import UpstreamUnavailableError
from ...domain.models import NormalizedProduct
from ...domain.policies.normalize import normalize_item
from ..retry import is_retryable, retry_wait
from .contract import (
    BUYWHERE_CONTRACT_FINGERPRINT,
    BUYWHERE_CONTRACT_VERSION,
    assess_buywhere_payload,
)

API_BASE = "https://api.buywhere.ai"
OBSERVATION_MAX_BYTES = 64 * 1024
_RAW_ITEM_FIELDS = frozenset(
    {
        "id", "title", "price", "merchant", "url", "image_url", "region",
        "country_code", "updated_at", "click_url", "affiliate_redirect_url",
        "has_affiliate_tracking", "is_affiliate", "affiliate_disclosure",
        "availability", "url_last_checked_at", "metadata",
    }
)


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
        max_concurrency: int = 3,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout
        self._base_url = base_url
        self._max_retries = max_retries
        # This source is process-scoped by the container.  The gate therefore
        # protects the provider across all missions, unlike the per-research
        # semaphore in gather_market_products.
        self._request_gate = asyncio.Semaphore(max(1, max_concurrency))
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
        async with self._request_gate:
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
        raise RuntimeError("BuyWhere retry loop exited without a result")

    async def search(
        self,
        query: str,
        country_code: str = "US",
        mode: str = "keyword",
        limit: int = 20,
        max_price: float | None = None,
    ) -> ProductSearchResult:
        params: dict[str, Any] = {
            "q": query,
            "country_code": country_code,
            "mode": mode,
            "limit": limit,
        }
        if max_price is not None:
            params["max_price"] = max_price
        body = await self._request("/v1/products/search", params)
        contract = assess_buywhere_payload(body)
        if not contract.compatible:
            raise UpstreamUnavailableError(
                code="provider_contract_drift",
                category="data",
                retryable=False,
                user_message="BuyWhere 商品数据结构发生不兼容变化",
            )
        resp = BuyWhereSearchResponse.model_validate(body)
        result = _normalize_response(
            resp,
            retrieval_context={
                "query": query,
                "country_code": country_code,
                "mode": mode,
                "limit": limit,
                "max_price": max_price,
            },
        )
        if contract.additive_fields:
            result.warnings.append(
                "BuyWhere 返回新增字段：" + ", ".join(contract.additive_fields)
            )
        return result

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

    async def get_product_with_observation(
        self, product_id: str
    ) -> tuple[NormalizedProduct, ProductObservation] | None:
        body = await self._request(f"/v1/products/{product_id}")
        contract = assess_buywhere_payload(body)
        if not contract.compatible:
            raise UpstreamUnavailableError(
                code="provider_contract_drift", category="data", retryable=False
            )
        resp = BuyWhereSearchResponse.model_validate(body)
        if not resp.data or resp.data[0].price is None or resp.data[0].price.amount is None:
            return None
        item = resp.data[0]
        product = normalize_item(item)
        observation = _observation_for(
            item,
            product,
            operation="detail",
            retrieval_context={"product_id": product_id},
        )
        return product, observation

    async def compare(self, ids: list[str]) -> list[BuyWhereProduct]:
        body = await self._request("/v1/products/compare", {"ids": ",".join(ids)})
        return BuyWhereSearchResponse.model_validate(body).data

    async def get_prices(self, product_id: str, days: int = 30) -> BuyWherePriceHistory:
        body = await self._request(f"/v1/products/{product_id}/prices", {"days": days})
        return BuyWherePriceHistory.model_validate(body.get("data", {}))


def _sanitize_value(value: Any, *, depth: int = 0) -> Any:
    if depth >= 5:
        return "[truncated]"
    if isinstance(value, str):
        return value[:2048]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_sanitize_value(item, depth=depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in list(value.items())[:100]:
            lowered = str(key).casefold()
            if any(secret in lowered for secret in ("api_key", "apikey", "token", "authorization", "cookie")):
                continue
            cleaned[str(key)] = _sanitize_value(item, depth=depth + 1)
        return cleaned
    return str(value)[:2048]


def _controlled_raw_item(item: BuyWhereProduct) -> dict[str, Any]:
    dumped = item.model_dump(mode="json", exclude_none=True)
    controlled = {
        key: _sanitize_value(value)
        for key, value in dumped.items()
        if key in _RAW_ITEM_FIELDS
    }
    if len(json.dumps(controlled, ensure_ascii=False).encode("utf-8")) > OBSERVATION_MAX_BYTES:
        controlled["metadata"] = {"_truncated": True}
    return controlled


def _field_provenance(product: NormalizedProduct) -> dict[str, Any]:
    mapping: dict[str, Any] = {
        "id": {"source_path": "id", "transform": "identity"},
        "title": {"source_path": "title", "transform": "identity"},
        "merchant": {"source_path": "merchant", "transform": "identity"},
        "native_price_amount": {"source_path": "price.amount", "transform": "numeric"},
        "native_currency": {"source_path": "price.currency", "transform": "uppercase"},
        "in_stock": {
            "source_path": (
                "availability.in_stock"
                if product.stock_source == "top_level"
                else "metadata.availability"
            ),
            "transform": "availability_normalization",
            "evidence_level": product.stock_source or "unknown",
        },
        "attrs": {"source_path": "metadata", "transform": "allowlisted_string_projection"},
    }
    return {key: value for key, value in mapping.items() if getattr(product, key, None) is not None}


def _observation_for(
    item: BuyWhereProduct,
    product: NormalizedProduct,
    *,
    operation: str,
    retrieval_context: dict[str, Any],
) -> ProductObservation:
    raw = _controlled_raw_item(item)
    return ProductObservation(
        source_product_id=item.id,
        operation=operation,
        provider_contract_version=BUYWHERE_CONTRACT_VERSION,
        contract_fingerprint=BUYWHERE_CONTRACT_FINGERPRINT,
        retrieval_context=dict(retrieval_context),
        normalized_facts=product.model_dump(mode="json"),
        field_provenance=_field_provenance(product),
        sanitized_raw_item=raw,
        raw_item=raw,
    )


def _normalize_response(
    resp: BuyWhereSearchResponse,
    *,
    retrieval_context: dict[str, Any] | None = None,
) -> ProductSearchResult:
    """原始响应 → 归一化商品列表；无价格商品跳过并计数（不伪造 0 元）。"""
    products: list[NormalizedProduct] = []
    observations: list[ProductObservation] = []
    skipped = 0
    for item in resp.data:
        if item.price is None or item.price.amount is None:
            skipped += 1
            continue
        product = normalize_item(item)
        products.append(product)
        observations.append(
            _observation_for(
                item,
                product,
                operation="search",
                retrieval_context=dict(retrieval_context or {}),
            )
        )
    meta = resp.meta or BuyWhereMeta()
    return ProductSearchResult(
        products=products,
        observations=observations,
        page_meta=SearchPageMeta(**meta.model_dump(exclude={"hint"})),
        skipped_no_price=skipped,
        provider_contract_version=BUYWHERE_CONTRACT_VERSION,
        contract_fingerprint=BUYWHERE_CONTRACT_FINGERPRINT,
    )
