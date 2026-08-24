"""多市场商品抓取（应用层，供 SearchService 与 Agent fetch 节点共用）。"""
from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from time import monotonic
from uuid import uuid4

from ...domain.models import NormalizedProduct
from ..dto import ProductObservation, ProductSearchResult, SearchExecution, SearchPageMeta
from ..errors import UpstreamUnavailableError
from ..ports import ProductSource


@dataclass
class MarketSearchOutcome:
    products: list[NormalizedProduct] = field(default_factory=list)
    failed_markets: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    executions: list[SearchExecution] = field(default_factory=list)
    observations: list[ProductObservation] = field(default_factory=list)


async def gather_market_products(
    products: ProductSource,
    *,
    query: str,
    markets: list[str],
    mode: str,
    limit: int,
    max_concurrency: int = 3,
    max_prices: dict[str, float] | None = None,
    goal_version: int | None = None,
) -> MarketSearchOutcome:
    """受限并发搜索；单市场 upstream 失败不拖垮整轮，鉴权/配置错误上抛。"""
    sem = asyncio.Semaphore(max_concurrency)
    caps = max_prices or {}

    async def _one(
        market: str,
    ) -> tuple[
        str,
        ProductSearchResult | UpstreamUnavailableError,
        datetime,
        datetime,
        int,
    ]:
        async with sem:
            started = datetime.now(UTC)
            clock = monotonic()
            try:
                result = await products.search(
                    query,
                    country_code=market,
                    mode=mode,
                    limit=limit,
                    max_price=caps.get(market),
                )
                completed = datetime.now(UTC)
                return market, result, started, completed, round((monotonic() - clock) * 1000)
            except UpstreamUnavailableError as exc:
                completed = datetime.now(UTC)
                return market, exc, started, completed, round((monotonic() - clock) * 1000)

    gathered = await asyncio.gather(*[_one(m) for m in markets])
    outcome = MarketSearchOutcome()
    for market, result, started, completed, latency_ms in gathered:
        request = {
            "query": query,
            "market": market,
            "mode": mode,
            "limit": limit,
            "max_price": caps.get(market),
        }
        fingerprint = hashlib.sha256(
            json.dumps(request, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        query_fingerprint = hashlib.sha256(
            json.dumps(
                {"query": " ".join(query.casefold().split()), "market": market, "mode": mode},
                sort_keys=True,
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        requested_params = {
            "q": query,
            "country_code": market,
            "mode": mode,
            "limit": limit,
            "max_price": caps.get(market),
        }
        page_meta: SearchPageMeta | dict = (
            result.page_meta if isinstance(result, ProductSearchResult) else {}
        )
        execution = SearchExecution(
            execution_id=str(uuid4()),
            goal_version=goal_version,
            query=query,
            market=market,
            mode=mode,
            requested_limit=limit,
            max_price=caps.get(market),
            requested_params=requested_params,
            started_at=started,
            completed_at=completed,
            latency_ms=latency_ms,
            request_fingerprint=fingerprint,
            contract_fingerprint=(
                result.contract_fingerprint if isinstance(result, ProductSearchResult) else None
            ),
            query_fingerprint=query_fingerprint,
            status="failed" if isinstance(result, UpstreamUnavailableError) else "succeeded",
            error_code=result.code if isinstance(result, UpstreamUnavailableError) else None,
            page_meta=page_meta,
            response_meta=(
                page_meta.model_dump(mode="json")
                if isinstance(page_meta, SearchPageMeta)
                else dict(page_meta)
            ),
        )
        outcome.executions.append(execution)
        if isinstance(result, UpstreamUnavailableError):
            if result.category == "system":
                raise result
            outcome.failed_markets.append(market)
            outcome.warnings.append(f"{market} 搜索失败: {result.code}")
            continue
        if result.skipped_no_price:
            outcome.warnings.append(f"{market} 跳过 {result.skipped_no_price} 件无价格商品")
        outcome.warnings.extend(result.warnings)
        outcome.products.extend(result.products)
        outcome.observations.extend(
            item.model_copy(update={"goal_version": goal_version})
            for item in result.observations
        )
    return outcome
