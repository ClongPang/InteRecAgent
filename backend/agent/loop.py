"""研究循环控制器：后端控环，模型只在 keep / 改写 / TopK 三个点出场。

环：检索 → FX+规则过滤 → 模型 keep（失败则本轮不并入）→ 并入累加池
→ 池子 ≥ N 或 检索次数 ≥ R 则停；否则改写 query 再搜。
停搜后模型按规则 prompt 从池子选 TopK；失败回退 score_and_rank。

无 Key 时同一条环，跳过三次模型调用，改写走确定性放宽。
"""
from __future__ import annotations

from ..application.dto import ToolCall
from ..application.ports import ModelBackend
from ..application.services.rec import VersionProbe, run_filter
from ..domain.models import DEFAULT_MARKETS
from ..application.services.working_set import decision_quality, select_decision_set
from .judges import judge_keep, parse_rewrite, rewrite_query, select_topk
from .pool import ground_products, merge_into_pool
from .tools import ResearchContext, ResearchTools


async def run_agent(
    ctx: ResearchContext,
    tools: ResearchTools,
    backend: ModelBackend,
    *,
    max_steps: int | None = None,
    version_probe: VersionProbe | None = None,
) -> None:
    del max_steps
    await run_research(ctx, tools, backend=backend, version_probe=version_probe)


async def run_deterministic(
    ctx: ResearchContext,
    tools: ResearchTools,
    *,
    version_probe: VersionProbe | None = None,
) -> None:
    await run_research(ctx, tools, backend=None, version_probe=version_probe)


async def run_research(
    ctx: ResearchContext,
    tools: ResearchTools,
    backend: ModelBackend | None = None,
    *,
    version_probe: VersionProbe | None = None,
) -> None:
    limits = ctx.limits
    if not ctx.current_query:
        ctx.current_query = ctx.plan.query or ""

    while ctx.search_count < limits.max_searches:
        if version_probe is not None and await version_probe():
            ctx.stale = True
            return

        args: dict = {"query": ctx.current_query}
        if ctx.relaxed_native_cap:
            args["skip_budget_cap"] = True
        await tools.run(
            ToolCall(id=f"search-{ctx.search_count}", name="search_products", arguments=args),
            ctx,
        )
        await tools.run(
            ToolCall(id=f"filter-{ctx.search_count}", name="filter_candidates", arguments={}),
            ctx,
        )

        batch = list(ctx.products)
        if backend is not None and backend.is_configured() and batch:
            keep_ids = await judge_keep(backend, ctx, batch)
            if keep_ids is None:
                ctx.add_warnings("模型过滤不可用，本轮不并入未判定批次")
                batch = []
            else:
                kept = ground_products(keep_ids, batch)
                ctx.add_warnings(f"模型本轮勾选 {len(kept)} / {len(batch)} 件")
                batch = kept

        added, dupes = merge_into_pool(ctx, batch)
        ctx.search_count += 1
        ctx.add_warnings(
            f"第 {ctx.search_count} 次检索并入 {added} 件（去重 {dupes}），池子 {len(ctx.pool)} 件"
        )

        if ctx.search_count >= limits.max_searches or len(ctx.pool) >= limits.pool_threshold:
            break
        if ctx.search_count >= 1 and decision_quality(_pool_views(ctx)).discriminable:
            ctx.add_warnings("决策集已可分辨，停止继续检索")
            break

        next_query = await _next_query(ctx, backend)
        if not next_query:
            break
        ctx.rewritten_queries.append(next_query)
        ctx.current_query = next_query

    if ctx.stale:
        return
    await _finalize_ranked(ctx, tools, backend)


async def _next_query(ctx: ResearchContext, backend: ModelBackend | None) -> str | None:
    if backend is not None and backend.is_configured():
        decision = await rewrite_query(backend, ctx)
        if decision.decided:
            return parse_rewrite(decision, ctx)
    return _deterministic_rewrite(ctx)


def _deterministic_rewrite(ctx: ResearchContext) -> str | None:
    if ctx.plan.budget_cny is not None and not ctx.relaxed_native_cap:
        ctx.relaxed_native_cap = True
        ctx.add_warnings("原币预算上限下召回不足，已放宽检索，仍按人民币预算过滤")
        return ctx.current_query
    current = list(ctx.plan.markets)
    widened = list(DEFAULT_MARKETS)
    if current and set(current) != set(widened):
        ctx.plan = ctx.plan.model_copy(update={"markets": widened})
        ctx.add_warnings("召回不足，已扩大到默认市场")
        return ctx.current_query
    return None


async def _finalize_ranked(
    ctx: ResearchContext,
    tools: ResearchTools,
    backend: ModelBackend | None,
) -> None:
    if not ctx.pool and ctx.mission.constraints.only_in_stock and ctx.converted_products:
        relaxed = ctx.mission.constraints.model_copy(update={"only_in_stock": False})
        products, warnings = run_filter(
            relaxed,
            ctx.converted_products,
            rejected_snapshot_ids=set(getattr(ctx.mission.belief, "rejected_snapshot_ids", []) or []),
            rejected_listing_keys=set(getattr(ctx.mission.belief, "rejected_listing_keys", []) or []),
            spec_gates=list(getattr(ctx.mission.belief, "spec_gates", []) or []),
        )
        if products:
            ctx.add_warnings("「仅看有货」导致空集，已按软条件放宽库存过滤")
            ctx.add_warnings(warnings)
            merge_into_pool(ctx, products)

    if not ctx.pool:
        ctx.ranked = []
        ctx.finalized = True
        return

    selected = None
    if backend is not None and backend.is_configured():
        ids = await select_topk(backend, ctx)
        if ids is not None:
            selected = ground_products(ids, ctx.pool)[: ctx.limits.top_k]
            if not selected:
                selected = None
                ctx.add_warnings("模型 TopK 没有落到池内 ID，已回退规则排序")
            else:
                ctx.add_warnings(f"模型从池子 {len(ctx.pool)} 件中选出 {len(selected)} 件")

    if selected is not None:
        ctx.ranked = selected
        ctx.products = list(ctx.pool)
        await tools.emit_ranked(len(ctx.ranked))
    else:
        ctx.products = list(ctx.pool)
        await tools.run(ToolCall(id="rank", name="rank_candidates", arguments={}), ctx)
        if len(ctx.ranked) > ctx.limits.top_k:
            ctx.ranked = ctx.ranked[: ctx.limits.top_k]
    _cap_decision_set(ctx)
    ctx.finalized = True


def _pool_views(ctx: ResearchContext) -> list[dict]:
    return [
        {
            "snapshot_id": item.id,
            "title": item.title,
            "merchant": item.merchant,
            "market": item.country_code,
            "estimated_cny": item.rmb_price,
        }
        for item in ctx.pool
    ]


def _cap_decision_set(ctx: ResearchContext) -> None:
    views = [
        {
            "snapshot_id": item.id,
            "title": item.title or "",
            "merchant": item.merchant,
            "market": item.country_code,
        }
        for item in ctx.ranked
    ]
    picked = select_decision_set(views, limit=ctx.limits.top_k)
    by_id = {item.id: item for item in ctx.ranked}
    ctx.ranked = [by_id[str(item["snapshot_id"])] for item in picked if str(item["snapshot_id"]) in by_id]
