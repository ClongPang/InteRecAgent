from __future__ import annotations

from typing import Protocol, runtime_checkable

from ...domain.models import NormalizedProduct
from ..dto import ProductSearchResult


@runtime_checkable
class ProductSource(Protocol):
    """商品源 Port。返回已归一化的领域商品；供应商原始响应只在 Infrastructure 内出现。
    无价格商品在适配器内跳过并计入 skipped_no_price。实现：infrastructure/product_sources/{buywhere,fixture}.py。"""

    async def search(
        self,
        query: str,
        *,
        country_code: str,
        mode: str = "keyword",
        limit: int = 20,
    ) -> ProductSearchResult: ...

    async def get_product(self, product_id: str) -> NormalizedProduct | None: ...
