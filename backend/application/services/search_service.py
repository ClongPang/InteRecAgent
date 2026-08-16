from __future__ import annotations

import asyncio

from ...domain.models import (
    VALID_MARKETS,
    FxSnapshot,
    NormalizedProduct,
    SearchParams,
    SearchResult,
)
from ...domain.policies import apply_budget_filter, convert_products, dedupe_products, rank_products
from ..dto import ProductSearchResult
from ..errors import UpstreamUnavailableError
from ..ports import FxSource, ProductSource


class SearchService:
    """异步搜索编排（应用层）。多市场受限并发；单市场失败不拖垮整体（BE-004）。

    流程：多市场搜索（受限并发，按市场输入顺序归并）→ 汇率换算 → 去重 → 硬过滤 → 排序。
    """

    def __init__(
        self,
        *,
        products: ProductSource,
        fx: FxSource,
        max_concurrency: int = 3,
    ) -> None:
        self._products = products
        self._fx = fx
        self._max_concurrency = max_concurrency

    async def run(self, params: SearchParams) -> SearchResult:
        result = SearchResult(
            query=params.query,
            markets=list(params.markets),
            mode=params.mode.value,
        )
        markets = [m for m in params.markets if m in VALID_MARKETS] or ["US"]
        if set(markets) != set(params.markets):
            result.warnings.append(f"忽略无效市场: {sorted(set(params.markets) - set(markets))}")

        products, failed_markets = await self._search_markets(params, markets, result)
        if not products:
            result.degraded = True
            result.warnings.append("无任何市场返回商品")
            return result

        # 汇率换算（逐币种，失败的币种降级）
        currencies: list[str] = []
        for p in products:
            if p.native_currency not in currencies:
                currencies.append(p.native_currency)
        rates: dict[str, FxSnapshot] = {}
        for cur in currencies:
            try:
                rates[cur] = await self._fx.get_rate(cur, "CNY")
            except UpstreamUnavailableError as exc:
                result.warnings.append(f"{cur}→CNY 汇率不可用: {exc.code}")
        if rates:
            result.fx = list(rates.values())
        products = convert_products(products, rates)

        # 去重（先于预算过滤，保持候选池干净）
        products = dedupe_products(products)

        # 硬过滤（预算）；换算失败的商品不因预算排除（部分成功原则）
        if params.budget_cny is not None:
            kept, over, fx_failed = apply_budget_filter(products, params.budget_cny)
            products = kept + fx_failed
            result.degraded = result.degraded or bool(fx_failed) or bool(over)
            if over:
                result.warnings.append(f"{len(over)} 件商品超出预算 {params.budget_cny:.0f} 元")

        # 排序（人民币价升序；换算失败排最后）
        result.products = rank_products(products)
        result.degraded = result.degraded or failed_markets > 0
        if not rates:
            result.degraded = True
            result.warnings.append("全部汇率不可用，仅保留原币价格")
        return result

    async def _search_markets(
        self, params: SearchParams, markets: list[str], result: SearchResult
    ) -> tuple[list[NormalizedProduct], int]:
        """受限并发多市场搜索，按市场输入顺序归并；单市场失败记录警告。"""
        sem = asyncio.Semaphore(self._max_concurrency)

        async def _one(market: str) -> tuple[str, ProductSearchResult | BaseException]:
            async with sem:
                try:
                    return market, await self._products.search(
                        query=params.query,
                        country_code=market,
                        mode=params.mode.value,
                        limit=params.limit,
                    )
                except UpstreamUnavailableError as exc:
                    return market, exc
                except Exception as exc:  # 非受控错误按失败处理，不吞掉 traceback
                    return market, exc

        gathered = await asyncio.gather(*[_one(m) for m in markets])
        products: list[NormalizedProduct] = []
        failed_markets = 0
        for market, outcome in gathered:
            if isinstance(outcome, UpstreamUnavailableError):
                if outcome.category == "system":
                    raise outcome  # 鉴权/配置错误：不静默降级
                failed_markets += 1
                result.warnings.append(f"{market} 搜索失败: {outcome.code}")
                continue
            if isinstance(outcome, Exception):
                failed_markets += 1
                result.warnings.append(f"{market} 搜索失败: 未知错误")
                continue
            if outcome.skipped_no_price:
                result.warnings.append(f"{market} 跳过 {outcome.skipped_no_price} 件无价格商品")
            result.warnings.extend(outcome.warnings)
            products.extend(outcome.products)
        return products, failed_markets
