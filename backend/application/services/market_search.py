"""多市场商品抓取（应用层，供 SearchService 与 Agent fetch 节点共用）。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from ...domain.models import NormalizedProduct
from ..errors import UpstreamUnavailableError
from ..ports import ProductSource


@dataclass
class MarketSearchOutcome:
    products: list[NormalizedProduct] = field(default_factory=list)
    failed_markets: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


async def gather_market_products(
    products: ProductSource,
    *,
    query: str,
    markets: list[str],
    mode: str,
    limit: int,
    max_concurrency: int = 3,
    max_prices: dict[str, float] | None = None,
) -> MarketSearchOutcome:
    """受限并发搜索；单市场 upstream 失败不拖垮整轮，鉴权/配置错误上抛。"""
    sem = asyncio.Semaphore(max_concurrency)
    caps = max_prices or {}

    async def _one(market: str) -> tuple[str, object]:
        async with sem:
            try:
                return market, await products.search(
                    query,
                    country_code=market,
                    mode=mode,
                    limit=limit,
                    max_price=caps.get(market),
                )
            except UpstreamUnavailableError as exc:
                return market, exc

    gathered = await asyncio.gather(*[_one(m) for m in markets])
    outcome = MarketSearchOutcome()
    for market, result in gathered:
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
    return outcome
