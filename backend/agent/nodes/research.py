"""研究节点：后端控环的检索子图。

有配置模型时走 keep / 改写 / TopK 三次 JSON；否则同一条环跳过模型步。
产物交给下游 verify_evidence → compose_recommendation → persist。
"""
from __future__ import annotations

from collections.abc import Callable

from ...application.ports import FxSource, ModelBackend, ProductSource, UnitOfWork
from ...application.services.progress import DurableRunProgress
from ...application.services.rec import plan_search, rec_state_from_mission
from ..loop import run_agent, run_deterministic
from ..state import MissionGraphState
from ..tools import ResearchContext, ResearchTools


def make_research(
    products: ProductSource,
    fx: FxSource,
    model_backend: ModelBackend,
    uow_factory: Callable[[], UnitOfWork],
    max_concurrency: int = 3,
):
    async def research(state: MissionGraphState) -> dict:
        mission = state["mission"]
        plan = plan_search(rec_state_from_mission(mission))
        ctx = ResearchContext(mission=mission, plan=plan)
        progress = DurableRunProgress(
            uow_factory, mission_id=mission.id, run_id=state["run_id"]
        )
        tools = ResearchTools(
            products, fx, max_concurrency=max_concurrency, progress=progress
        )

        if model_backend.is_configured():
            await run_agent(
                ctx,
                tools,
                model_backend,
                version_probe=_make_version_probe(
                    uow_factory,
                    owner_id=state["owner_id"],
                    mission_id=state["mission_id"],
                    run_version=state["run_version"],
                ),
            )
        else:
            await run_deterministic(ctx, tools)

        return {
            "search_plan": plan,
            "products": ctx.ranked,
            "ranked": ctx.ranked,
            "pool": list(ctx.pool),
            "rates": ctx.rates,
            "fx": list(ctx.rates.values()),
            "fx_failed_currencies": ctx.fx_failed_currencies,
            "failed_markets": ctx.failed_markets,
            "warnings": list(ctx.warnings),
        }

    return research


def _make_version_probe(
    uow_factory: Callable[[], UnitOfWork],
    *,
    owner_id: str,
    mission_id: str,
    run_version: int,
):
    async def probe() -> bool:
        async with uow_factory() as uow:
            current = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
        return current is None or current.constraints_version != run_version

    return probe
