from __future__ import annotations

from ...domain.models import (
    DEFAULT_MARKETS,
    VALID_MARKETS,
    FxSnapshot,
    SearchParams,
    SearchResult,
)
from ...domain.policies import apply_budget_filter, convert_products, dedupe_products, rank_products
from ..errors import UpstreamUnavailableError
from ..ports import FxSource, ProductSource
from .market_search import gather_market_products
from .rec.pipeline import market_native_caps


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
        markets = [m for m in params.markets if m in VALID_MARKETS] or list(DEFAULT_MARKETS)
        if set(markets) != set(params.markets):
            result.warnings.append(f"忽略无效市场: {sorted(set(params.markets) - set(markets))}")

        caps, cap_failed = await market_native_caps(self._fx, markets, params.budget_cny)
        if cap_failed:
            result.warnings.append(
                f"以下币种汇率暂不可用，对应市场未设原币预算上限：{'、'.join(cap_failed)}"
            )

        outcome = await gather_market_products(
            self._products,
            query=params.query,
            markets=markets,
            mode=params.mode.value,
            limit=params.limit,
            max_concurrency=self._max_concurrency,
            max_prices=caps or None,
        )
        result.warnings.extend(outcome.warnings)
        products = outcome.products
        if not products:
            result.degraded = True
            result.warnings.append("无任何市场返回商品")
            return result

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

        products = dedupe_products(products)

        if params.budget_cny is not None:
            kept, over, fx_failed = apply_budget_filter(products, params.budget_cny)
            products = kept + fx_failed
            result.degraded = result.degraded or bool(fx_failed) or bool(over)
            if over:
                result.warnings.append(f"{len(over)} 件商品超出预算 {params.budget_cny:.0f} 元")

        result.products = rank_products(products)
        result.degraded = result.degraded or bool(outcome.failed_markets)
        if not rates:
            result.degraded = True
            result.warnings.append("全部汇率不可用，仅保留原币价格")
        return result
