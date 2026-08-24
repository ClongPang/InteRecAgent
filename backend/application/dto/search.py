from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from ...domain.models import NormalizedProduct, utcnow


class SearchPageMeta(BaseModel):
    total: int | None = None
    limit: int | None = None
    offset: int | None = None
    response_time_ms: int | None = None
    cached: bool | None = None
    has_more: bool | None = None
    continuation: str | None = None


class ProductObservation(BaseModel):
    """Sanitized provider item plus the context in which it was observed."""

    snapshot_id: str | None = None
    goal_version: int | None = None
    source: str = "buywhere"
    source_product_id: str
    operation: str = "search"
    observed_at: datetime = Field(default_factory=utcnow)
    provider_contract_version: str
    contract_fingerprint: str | None = None
    retrieval_context: dict[str, Any] = Field(default_factory=dict)
    normalized_facts: dict[str, Any] = Field(default_factory=dict)
    field_provenance: dict[str, Any] = Field(default_factory=dict)
    sanitized_raw_item: dict[str, Any] = Field(default_factory=dict)
    # Transitional serialization key used by already persisted snapshots.
    raw_item: dict[str, Any] = Field(default_factory=dict)


class SearchExecution(BaseModel):
    execution_id: str
    goal_version: int | None = None
    provider: str = "buywhere"
    query: str
    market: str
    mode: str
    requested_limit: int
    offset: int | None = None
    max_price: float | None = None
    requested_params: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime
    completed_at: datetime
    latency_ms: int
    request_fingerprint: str
    contract_fingerprint: str | None = None
    query_fingerprint: str | None = None
    status: str = "succeeded"
    error_code: str | None = None
    page_meta: SearchPageMeta = Field(default_factory=SearchPageMeta)
    response_meta: dict[str, Any] = Field(default_factory=dict)


class ProductSearchResult(BaseModel):
    """单个市场商品搜索的结构化结果。无价格商品在适配器内跳过并计数，避免进入领域层。"""

    products: list[NormalizedProduct] = Field(default_factory=list)
    page_meta: SearchPageMeta = Field(default_factory=SearchPageMeta)
    observations: list[ProductObservation] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    skipped_no_price: int = 0
    provider_contract_version: str | None = None
    contract_fingerprint: str | None = None
