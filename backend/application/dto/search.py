from __future__ import annotations

from pydantic import BaseModel, Field

from ...domain.models import NormalizedProduct


class ProductSearchResult(BaseModel):
    """单个市场商品搜索的结构化结果。无价格商品在适配器内跳过并计数，避免进入领域层。"""

    products: list[NormalizedProduct] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    skipped_no_price: int = 0
