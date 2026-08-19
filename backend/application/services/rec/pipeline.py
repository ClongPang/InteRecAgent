"""检索流水线的确定性步骤（单一事实源）。

这些纯步骤既被图节点（refilter/rerank 路径）复用，也被 Agent 工具循环复用，
避免「静态编排」与「动态 tool-use」两套实现漂移。硬约束（FX→预算顺序、库存事实判定、
排除项、否定候选）在此焊死，无论调用方以何种顺序驱动，事实层结果一致。
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable

from ....domain.models import DEFAULT_MARKETS, MARKET_CURRENCY, FxSnapshot, NormalizedProduct
from ....domain.policies import (
    apply_budget_filter,
    apply_exclusion_filter,
    apply_stock_filter,
    convert_products,
    dedupe_products,
    derive_title_attrs,
)
from ...dto.mission import MissionConstraints, ShoppingMission
from ...errors import UpstreamUnavailableError
from ...ports import FxSource, ProductSource
from ..market_search import MarketSearchOutcome, gather_market_products
from .rank import preference_hits, rank_with_belief
from .state import rec_state_from_mission


def native_budget_cap(budget_cny: float, rate: float) -> float:
    """人民币预算 ÷ (1 原币兑人民币) = 该市场检索上限。"""
    if rate <= 0:
        raise ValueError("fx rate must be positive")
    return round(budget_cny / rate, 2)


async def market_native_caps(
    fx: FxSource,
    markets: list[str],
    budget_cny: float | None,
) -> tuple[dict[str, float], list[str]]:
    """各市场原币 max_price。缺汇率的市场不设上限，由调用方照常检索再做人民币过滤。"""
    if budget_cny is None:
        return {}, []
    caps: dict[str, float] = {}
    failed: list[str] = []
    seen: set[str] = set()
    for market in markets:
        currency = MARKET_CURRENCY.get(market)
        if not currency or currency in seen:
            continue
        seen.add(currency)
        try:
            snap = await fx.get_rate(currency, "CNY")
        except UpstreamUnavailableError:
            failed.append(currency)
            continue
        cap = native_budget_cap(budget_cny, snap.rate)
        for code in markets:
            if MARKET_CURRENCY.get(code) == currency:
                caps[code] = cap
    return caps, failed


async def run_search(
    products: ProductSource,
    *,
    query: str,
    markets: list[str],
    mode: str,
    limit: int,
    max_concurrency: int = 3,
    max_prices: dict[str, float] | None = None,
) -> MarketSearchOutcome:
    """多市场受限并发检索。单市场 upstream 失败降级为 failed_markets，鉴权错误上抛。"""
    return await gather_market_products(
        products,
        query=query or "",
        markets=markets or list(DEFAULT_MARKETS),
        mode=mode,
        limit=limit,
        max_concurrency=max_concurrency,
        max_prices=max_prices,
    )


async def run_fx(
    fx: FxSource, products: list[NormalizedProduct]
) -> tuple[dict[str, FxSnapshot], list[str]]:
    """逐币种取汇率；失败币种降级保留原币（返回 failed 币种列表）。"""
    currencies: list[str] = []
    for product in products:
        if product.native_currency not in currencies:
            currencies.append(product.native_currency)
    rates: dict[str, FxSnapshot] = {}
    failed: list[str] = []
    for currency in currencies:
        try:
            rates[currency] = await fx.get_rate(currency, "CNY")
        except UpstreamUnavailableError:
            failed.append(currency)
    return rates, failed


def normalize_products(
    products: list[NormalizedProduct], rates: dict[str, FxSnapshot]
) -> list[NormalizedProduct]:
    """去重 + 标题派生 + 汇率换算（必须在预算过滤之前完成）。"""
    deduped = [derive_title_attrs(item) for item in dedupe_products(products)]
    return convert_products(deduped, rates)


def run_filter(
    constraints: MissionConstraints,
    products: list[NormalizedProduct],
    *,
    rejected_snapshot_ids: set[str] | None = None,
    snapshot_map: dict[str, str] | None = None,
) -> tuple[list[NormalizedProduct], list[str]]:
    """硬过滤：否定候选、有货事实、排除词、预算。无库存事实时不筛。"""
    warnings: list[str] = []
    original = list(products)
    rejected = set(rejected_snapshot_ids or set())
    snapshot_map = snapshot_map or {}

    if rejected:
        before = len(products)
        products = [
            product
            for product in products
            if snapshot_map.get(product.id, product.id) not in rejected
            and product.id not in rejected
        ]
        if len(products) < before:
            warnings.append(f"已排除 {before - len(products)} 件被否定的候选")

    if constraints.only_in_stock:
        kept, out, unknown = apply_stock_filter(products)
        if any(item.in_stock is not None for item in original):
            products = kept
            if out:
                warnings.append(f"{len(out)} 件无货，已按「仅看有货」去掉")
            if unknown:
                warnings.append(f"{len(unknown)} 件没有库存事实，未列入仅看有货结果")
        else:
            warnings.append("当前候选没有库存事实，「仅看有货」未生效")

    if constraints.excluded_terms:
        products, dropped = apply_exclusion_filter(products, constraints.excluded_terms)
        if dropped:
            warnings.append(
                f"已按排除词过滤 {len(dropped)} 件（标题匹配：{'、'.join(constraints.excluded_terms)}）"
            )

    if constraints.budget_cny is not None:
        kept, over, fx_failed = apply_budget_filter(products, constraints.budget_cny)
        products = kept + fx_failed
        if over:
            warnings.append(f"{len(over)} 件商品超出预算 {constraints.budget_cny:.0f} 元")

    return products, warnings


def _category_supports_audio_preference(query: str) -> bool:
    return "耳机" in query or "headphone" in query.lower() or "降噪" in query


def run_rank(
    mission: ShoppingMission,
    products: list[NormalizedProduct],
    *,
    snapshot_map: dict[str, str] | None = None,
) -> tuple[list[NormalizedProduct], list[str]]:
    """多目标排序。信念与标题派生进入打分；无线索时只警告，不编造分数。"""
    warnings: list[str] = []
    rec = rec_state_from_mission(mission)
    preference = rec.preference
    if preference in {"battery", "noise"}:
        hits = preference_hits(products, preference)
        if hits == 0:
            warnings.append(f"当前候选标题没有「{preference}」线索，已主要按商品价排序")
        elif not _category_supports_audio_preference(rec.query or ""):
            warnings.append(f"当前商品数据无法按「{preference}」维度排序，已按商品价排序")

    snapshot_map = snapshot_map or {}
    rejected = {
        source_id
        for source_id, snapshot_id in snapshot_map.items()
        if snapshot_id in rec.rejected_snapshot_ids
    }
    ranked = rank_with_belief(products, rec, rejected_source_ids=rejected)
    return ranked, warnings


# 供研究节点在昂贵工具（检索）前探测运行是否被新版本约束取代。
VersionProbe = Callable[[], Awaitable[bool]]
