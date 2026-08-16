from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(UTC)


class SearchMode(StrEnum):
    KEYWORD = "keyword"
    HYBRID = "hybrid"
    SEMANTIC = "semantic"


# 经真实 API 实测可用于搜索的市场（country_code 不等于配送目的地）。
VALID_MARKETS = ("US", "SG", "VN", "TH", "MY")


class FxSnapshot(BaseModel):
    """一次汇率事实快照。date 为汇率源（ECB）的汇率日期，fetched_at 为本地抓取时间。"""

    base: str
    quote: str
    rate: float
    date: str
    source: str
    fetched_at: datetime = Field(default_factory=utcnow)


# 真实 BuyWhere 响应中不存在的字段名，归一化时显式标记为 unavailable。
# 架构文档/前端 mock 假设了这些字段，但真实 API 提供不了——诚实标记而非填默认值。
API_MISSING_FIELDS = (
    "rating",
    "review_count",
    "brand",
    "availability",
    "structured_specs",
    "original_price",
    "discount_pct",
)


class NormalizedProduct(BaseModel):
    """已归一化的商品事实。只含真实 API 字段；缺失字段记录在 unavailable。"""

    id: str
    title: str
    merchant: str | None = None
    country_code: str | None = None
    region: str | None = None
    url: str | None = None
    click_url: str | None = None
    image_url: str | None = None
    updated_at: datetime | None = None

    native_price_amount: float
    native_currency: str
    rmb_price: float | None = None  # 换算失败/未换算时为 None
    fx_as_of: str | None = None  # 所用汇率的 date
    fx_failed: bool = False  # 换算失败，保留原币

    unavailable: list[str] = Field(default_factory=list)


class SearchParams(BaseModel):
    query: str
    markets: list[str] = Field(default_factory=lambda: ["US"])
    mode: SearchMode = SearchMode.KEYWORD
    limit: int = 20
    budget_cny: float | None = None


class SearchResult(BaseModel):
    query: str
    markets: list[str]
    mode: str
    fetched_at: datetime = Field(default_factory=utcnow)
    products: list[NormalizedProduct] = Field(default_factory=list)
    fx: list[FxSnapshot] = Field(default_factory=list)
    degraded: bool = False  # 部分成功（如汇率不可用）
    warnings: list[str] = Field(default_factory=list)

    def currencies(self) -> list[str]:
        seen: list[str] = []
        for p in self.products:
            if p.native_currency not in seen:
                seen.append(p.native_currency)
        return seen
