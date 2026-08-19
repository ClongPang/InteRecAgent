from __future__ import annotations

import json
from pathlib import Path

from ...application.dto import ProductSearchResult
from ...domain.models import NormalizedProduct
from .buywhere import BuyWhereSearchResponse, _normalize_response


class FixtureProductSource:
    """从脱敏 fixture 读取商品的商品源（Fixture Mode）。

    不访问外网、无第三方 Key。按 market 读取 `tests/fixtures/buywhere/*_{market}.json`；
    无对应 fixture 的市场返回空结果（保持"部分市场失败"语义），不抛错。
    """

    def __init__(self, fixtures_dir: Path) -> None:
        self._dir = Path(fixtures_dir)
        self._cache: dict[str, BuyWhereSearchResponse] = {}

    async def search(
        self,
        query: str,
        *,
        country_code: str,
        mode: str = "keyword",
        limit: int = 20,
        max_price: float | None = None,
    ) -> ProductSearchResult:
        del query, mode
        resp = self._load_market(country_code)
        result = _normalize_response(resp)
        if max_price is not None:
            result.products = [
                item for item in result.products if item.native_price_amount <= max_price
            ]
        result.products = result.products[:limit]
        return result

    async def get_product(self, product_id: str) -> NormalizedProduct | None:
        for resp in self._load_all():
            for item in resp.data:
                if item.id == product_id and item.price and item.price.amount:
                    from ...domain.policies.normalize import normalize_item

                    return normalize_item(item)
        return None

    def _load_market(self, country_code: str) -> BuyWhereSearchResponse:
        key = country_code.upper()
        if key in self._cache:
            return self._cache[key]
        matches = sorted(self._dir.glob(f"*_{country_code.lower()}.json"))
        resp = (
            BuyWhereSearchResponse.model_validate(json.loads(matches[0].read_text(encoding="utf-8")))
            if matches
            else BuyWhereSearchResponse(data=[], meta=None)
        )
        self._cache[key] = resp
        return resp

    def _load_all(self) -> list[BuyWhereSearchResponse]:
        seen: list[BuyWhereSearchResponse] = []
        for path in sorted(self._dir.glob("*.json")):
            if path.name.startswith("fx_"):
                continue
            body = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(body, dict) and "data" in body:
                seen.append(BuyWhereSearchResponse.model_validate(body))
        return seen
