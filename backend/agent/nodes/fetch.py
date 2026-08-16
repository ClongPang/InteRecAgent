"""接收输入与抓取商品/汇率节点。只依赖注入的 Port/UnitOfWork 工厂，不 import Infrastructure。"""
from __future__ import annotations

import asyncio
from collections.abc import Callable

from ...application.dto import RunnerStatus, SearchPlan
from ...application.errors import UpstreamUnavailableError
from ...application.ports import FxSource, ProductSource, UnitOfWork
from ...domain.models import VALID_MARKETS, FxSnapshot, NormalizedProduct
from ..state import MissionGraphState


def make_receive_message(uow_factory: Callable[[], UnitOfWork]):
    """接收输入：加载任务投影与最新用户消息（读事务）。"""

    async def receive_message(state: MissionGraphState) -> dict:
        async with uow_factory() as uow:
            mission = await uow.missions.get(
                owner_id=state["owner_id"], mission_id=state["mission_id"]
            )
            if mission is None:
                return {"status": RunnerStatus.FAILED, "warnings": ["任务不存在"]}
            events = await uow.events.list_since(mission_id=state["mission_id"])
        text = ""
        for event in reversed(events):
            if event["event_type"] == "message.received":
                text = event["payload"].get("text", "")
                break
        return {"mission": mission, "text": text}

    return receive_message


def make_build_search_plan():
    """规划搜索：按当前约束生成搜索计划。"""

    async def build_search_plan(state: MissionGraphState) -> dict:
        constraints = state["mission"].constraints
        markets = [m for m in constraints.markets if m in VALID_MARKETS] or ["US"]
        return {
            "search_plan": SearchPlan(
                query=constraints.query,
                markets=markets,
                mode="keyword",
                budget_cny=constraints.budget_cny,
            )
        }

    return build_search_plan


def make_fetch_products(products: ProductSource, max_concurrency: int = 3):
    """抓取商品：多市场受限并发，按市场输入顺序归并（BE-004）。"""

    async def fetch_products(state: MissionGraphState) -> dict:
        plan = state["search_plan"]
        sem = asyncio.Semaphore(max_concurrency)

        async def _one(market: str):
            async with sem:
                try:
                    return market, await products.search(
                        plan.query, country_code=market, mode=plan.mode, limit=plan.limit
                    )
                except UpstreamUnavailableError as exc:
                    return market, exc

        gathered = await asyncio.gather(*[_one(m) for m in plan.markets])
        all_products: list[NormalizedProduct] = []
        failed_markets: list[str] = []
        warnings: list[str] = []
        for market, outcome in gathered:
            if isinstance(outcome, UpstreamUnavailableError):
                if outcome.category == "system":
                    raise outcome  # 鉴权/配置错误不静默降级
                failed_markets.append(market)
                warnings.append(f"{market} 搜索失败: {outcome.code}")
                continue
            if outcome.skipped_no_price:
                warnings.append(f"{market} 跳过 {outcome.skipped_no_price} 件无价格商品")
            warnings.extend(outcome.warnings)
            all_products.extend(outcome.products)
        return {"products": all_products, "failed_markets": failed_markets, "warnings": warnings}

    return fetch_products


def make_fetch_fx(fx: FxSource):
    """抓取汇率：逐币种，失败币种降级保留原币。"""

    async def fetch_fx(state: MissionGraphState) -> dict:
        currencies: list[str] = []
        for p in state.get("products", []):
            if p.native_currency not in currencies:
                currencies.append(p.native_currency)
        rates: dict[str, FxSnapshot] = {}
        failed: list[str] = []
        for cur in currencies:
            try:
                rates[cur] = await fx.get_rate(cur, "CNY")
            except UpstreamUnavailableError:
                failed.append(cur)
        return {
            "rates": rates,
            "fx": list(rates.values()),
            "fx_failed_currencies": failed,
        }

    return fetch_fx
