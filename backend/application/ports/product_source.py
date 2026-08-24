from __future__ import annotations

from typing import Protocol, runtime_checkable

from ...domain.models import NormalizedProduct
from ..dto import ProductSearchResult


@runtime_checkable
class ProductSource(Protocol):
    """商品源 Port。

    Search returns normalized products together with page metadata and sanitized
    provider observations. Secrets, headers and unbounded response bodies never
    cross this boundary.
    """

    async def search(
        self,
        query: str,
        *,
        country_code: str,
        mode: str = "keyword",
        limit: int = 20,
        max_price: float | None = None,
    ) -> ProductSearchResult: ...

    async def get_product(self, product_id: str) -> NormalizedProduct | None: ...
