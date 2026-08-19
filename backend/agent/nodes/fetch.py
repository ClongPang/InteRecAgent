"""接收输入与抓取商品/汇率节点。只依赖注入的 Port/UnitOfWork 工厂，不 import Infrastructure。"""
from __future__ import annotations

from collections.abc import Callable

from ...application.dto import RunnerStatus
from ...application.errors import UpstreamUnavailableError
from ...application.ports import FxSource, ProductSource, UnitOfWork
from ...application.services.market_search import gather_market_products
from ...application.services.nlu import build_turn_context
from ...application.services.rec import plan_search, rec_state_from_mission
from ...domain.models import FxSnapshot
from ..state import MissionGraphState

_CONSTRAINT_TRIGGERS = frozenset({"constraints.updated", "constraints.undo", "run.accepted"})


def make_receive_message(uow_factory: Callable[[], UnitOfWork]):
    """接收输入：加载任务，并绑定到本次 run_id 对应的触发事件。"""

    async def receive_message(state: MissionGraphState) -> dict:
        async with uow_factory() as uow:
            mission = await uow.missions.get(
                owner_id=state["owner_id"], mission_id=state["mission_id"]
            )
            if mission is None:
                return {"status": RunnerStatus.FAILED, "warnings": ["任务不存在"]}
            events = await uow.events.list_since(mission_id=state["mission_id"])
            cache_payload = None
            if mission.candidate_set_id:
                cache_payload = await uow.candidate_sets.get(mission.candidate_set_id)
        bound = _bind_trigger(mission, events, state["run_id"])
        bound["cache_payload"] = cache_payload
        bound["turn_context"] = build_turn_context(events, mission, cache_payload)
        return bound

    return receive_message


def _bind_trigger(mission, events: list[dict], run_id: str) -> dict:
    matched = None
    latest_message = None
    for event in events:
        if event["event_type"] == "message.received":
            latest_message = event
        if event.get("payload", {}).get("run_id") == run_id:
            matched = event
    if matched is not None:
        if matched["event_type"] == "message.received":
            payload = matched["payload"]
            return {
                "mission": mission,
                "text": payload.get("text", ""),
                "skip_intent_patch": bool(payload.get("skip_intent_patch")),
                "decided_route": payload.get("turn_route"),
                "decided_act": payload.get("act_payload"),
            }
        if matched["event_type"] in _CONSTRAINT_TRIGGERS:
            return {"mission": mission, "text": "", "skip_intent_patch": True}
    text = ""
    if latest_message is not None:
        text = latest_message.get("payload", {}).get("text", "")
    return {"mission": mission, "text": text, "skip_intent_patch": False}


def make_build_search_plan():
    """规划搜索：按当前约束生成搜索计划。"""

    async def build_search_plan(state: MissionGraphState) -> dict:
        return {"search_plan": plan_search(rec_state_from_mission(state["mission"]))}

    return build_search_plan


def make_fetch_products(products: ProductSource, max_concurrency: int = 3):
    """抓取商品：只走 search。详情接口与搜索同构，不用于富化。"""

    async def fetch_products(state: MissionGraphState) -> dict:
        plan = state["search_plan"]
        outcome = await gather_market_products(
            products,
            query=plan.query or "",
            markets=plan.markets,
            mode=plan.mode,
            limit=plan.limit,
            max_concurrency=max_concurrency,
        )
        return {
            "products": outcome.products,
            "failed_markets": outcome.failed_markets,
            "warnings": outcome.warnings,
        }

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
