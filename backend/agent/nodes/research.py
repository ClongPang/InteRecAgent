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
from ..tools import ResearchContext, ResearchLimits, ResearchTools


def make_research(
    products: ProductSource,
    fx: FxSource,
    model_backend: ModelBackend,
    uow_factory: Callable[[], UnitOfWork],
    max_concurrency: int = 3,
    *,
    enabled_item_types: frozenset[str] | None = None,
    max_wall_time_ms: int = 20_000,
):
    async def research(state: MissionGraphState) -> dict:
        mission = state["mission"]
        plan = plan_search(rec_state_from_mission(mission))
        ctx = ResearchContext(
            mission=mission,
            plan=plan,
            enabled_item_types=enabled_item_types or frozenset(),
            limits=ResearchLimits(max_wall_time_ms=max_wall_time_ms),
        )
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

        if ctx.goal_coverage is not None:
            ctx.goal_coverage = ctx.goal_coverage.model_copy(
                update={
                    "search_attempt_count": ctx.search_count,
                    "request_count": ctx.request_count,
                    "request_budget": ctx.limits.max_total_requests,
                    "remaining_request_budget": max(
                        0, ctx.limits.max_total_requests - ctx.request_count
                    ),
                    "remaining_time_ms": ctx.remaining_time_ms(),
                    "model_call_count": ctx.model_call_count,
                    "model_call_budget": ctx.limits.max_model_calls,
                    "remaining_model_calls": max(
                        0, ctx.limits.max_model_calls - ctx.model_call_count
                    ),
                    "estimated_token_count": ctx.estimated_token_count,
                    "token_budget": ctx.limits.max_estimated_tokens,
                    "remaining_token_budget": max(
                        0, ctx.limits.max_estimated_tokens - ctx.estimated_token_count
                    ),
                    "marginal_unique_observations": ctx.marginal_unique_observations,
                    "marginal_eligible_count": ctx.marginal_eligible_count,
                    "consecutive_no_gain": ctx.consecutive_no_gain,
                    "stop_reason": ctx.stop_reason,
                }
            )

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
            "goal_coverage": (
                ctx.goal_coverage.model_dump(mode="json") if ctx.goal_coverage else None
            ),
            "qualifications": [
                item.model_dump(mode="json") for item in ctx.qualifications.values()
            ],
            "query_trace": [item.model_dump(mode="json") for item in ctx.query_trace],
            "search_executions": [
                item.model_dump(mode="json") for item in ctx.search_executions
            ],
            "product_observations": [
                item.model_dump(mode="json") for item in ctx.product_observations.values()
            ],
            "semantic_profile_proposals": dict(ctx.semantic_profile_proposals),
            "semantic_profile_shadow": dict(ctx.semantic_profile_shadow),
            "semantic_shadow_stats": dict(ctx.semantic_shadow_stats),
            "research_proposals": [item.model_dump(mode="json") for item in ctx.proposals],
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
