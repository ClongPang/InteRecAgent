"""研究循环控制器：后端控环，模型只在 keep / 改写 / TopK 三个点出场。

环：检索 → FX+规则过滤 → 模型 keep（失败则本轮不并入）→ 并入累加池
→ 池子 ≥ N 或 检索次数 ≥ R 则停；否则改写 query 再搜。
停搜后模型按规则 prompt 从池子选 TopK；失败回退 score_and_rank。

无 Key 时同一条环，跳过三次模型调用，改写走确定性放宽。
"""

from __future__ import annotations

from uuid import uuid4

from ..application.dto import (
    QueryPurpose,
    ResearchProposal,
    ResearchQueryTrace,
    ToolCall,
)
from ..application.ports import ModelBackend
from ..application.services.rec import VersionProbe, assess_goal_coverage
from ..application.services.working_set import decision_quality, select_decision_set
from ..domain.category_contracts import semantic_shadow_enabled
from ..domain.models import DEFAULT_MARKETS
from .judges import (
    judge_keep,
    parse_rewrite,
    rewrite_query,
    shadow_semantic_profiles,
)
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
        if ctx.wall_time_exhausted():
            ctx.stop_reason = "time_budget_exhausted"
            ctx.add_warnings("研究时间预算已用尽，停止继续检索")
            break
        if ctx.request_count >= limits.max_total_requests:
            ctx.stop_reason = "request_budget_exhausted"
            ctx.add_warnings("上游请求预算已用尽，停止继续检索")
            break
        if version_probe is not None and await version_probe():
            ctx.stale = True
            return

        purpose = QueryPurpose.RECALL if ctx.search_count == 0 else QueryPurpose.RECALL_REFINEMENT
        if ctx.relaxed_native_cap:
            purpose = QueryPurpose.BUDGET_CAP_RELAXATION
        ctx.query_trace.append(
            ResearchQueryTrace(
                query=ctx.current_query,
                markets=list(ctx.plan.markets),
                purpose=purpose,
                search_index=ctx.search_count,
            )
        )
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
        if (
            backend is not None
            and backend.is_configured()
            and batch
            and semantic_shadow_enabled(ctx.mission.goal.target.item_type)
        ):
            await shadow_semantic_profiles(backend, ctx, batch)
        if ctx.goal_coverage is not None and ctx.goal_coverage.status == "blocked_on_evidence":
            enriched = await tools.supplement_evidence(ctx)
            if enriched:
                batch.extend(enriched)
                ctx.add_warnings(f"详情补证后新增 {len(enriched)} 件合格候选")
        if backend is not None and backend.is_configured() and batch:
            qualified_batch = list(batch)
            keep_ids = await judge_keep(backend, ctx, batch)
            if keep_ids is None:
                ctx.add_warnings("模型过滤不可用，已保留资格门通过的候选")
                batch = qualified_batch
            else:
                kept = ground_products(keep_ids, batch)
                kept = _preserve_feasible_coverage(ctx, qualified_batch, kept)
                ctx.add_warnings(f"模型本轮勾选 {len(kept)} / {len(batch)} 件")
                batch = kept

        added, dupes = merge_into_pool(ctx, batch)
        _refresh_pool_coverage(ctx)
        ctx.marginal_unique_observations = added
        if ctx.goal_coverage is not None:
            eligible_count = ctx.goal_coverage.eligible_count
            ctx.marginal_eligible_count = max(0, eligible_count - ctx.eligible_count_seen)
            ctx.eligible_count_seen = max(ctx.eligible_count_seen, eligible_count)
        else:
            ctx.marginal_eligible_count = added
        ctx.consecutive_no_gain = (
            ctx.consecutive_no_gain + 1 if ctx.marginal_eligible_count == 0 else 0
        )
        ctx.search_count += 1
        if ctx.goal_coverage is not None:
            ctx.goal_coverage = ctx.goal_coverage.model_copy(
                update={
                    "search_attempt_count": ctx.search_count,
                    "request_count": ctx.request_count,
                    "request_budget": limits.max_total_requests,
                    "marginal_unique_observations": added,
                    "marginal_eligible_count": ctx.marginal_eligible_count,
                    "consecutive_no_gain": ctx.consecutive_no_gain,
                }
            )
        ctx.add_warnings(
            f"第 {ctx.search_count} 次检索并入 {added} 件（去重 {dupes}），池子 {len(ctx.pool)} 件"
        )

        if ctx.goal_coverage is not None and ctx.goal_coverage.status == "sufficient":
            ctx.add_warnings("目标覆盖度已满足，停止继续检索")
            ctx.stop_reason = "coverage_sufficient"
            break
        if ctx.search_count >= limits.max_searches:
            ctx.stop_reason = "search_budget_exhausted"
            break
        if ctx.consecutive_no_gain >= limits.max_consecutive_no_gain:
            ctx.stop_reason = "consecutive_no_gain"
            ctx.add_warnings("连续检索没有新增合格候选，停止继续检索")
            break
        if ctx.goal_coverage is None and len(ctx.pool) >= limits.pool_threshold:
            break
        if (
            ctx.goal_coverage is None
            and ctx.search_count >= 1
            and decision_quality(_pool_views(ctx)).discriminable
        ):
            ctx.add_warnings("决策集已可分辨，停止继续检索")
            break

        next_query = await _next_query(ctx, backend)
        if not next_query:
            break
        ctx.rewritten_queries.append(next_query)
        ctx.current_query = next_query

    if ctx.stale:
        return
    if ctx.goal_coverage is not None and ctx.goal_coverage.status == "blocked_on_evidence":
        ctx.add_warnings("候选仍缺少满足硬约束所需的证据，结果不会按已确认事实呈现")
    if ctx.goal_coverage is not None and ctx.goal_coverage.missing_markets:
        ctx.add_warnings("指定市场仍无合格候选：" + "、".join(ctx.goal_coverage.missing_markets))
    await _finalize_ranked(ctx, tools, backend)


def _refresh_pool_coverage(ctx: ResearchContext) -> None:
    """Coverage is about the code-owned feasible pool, not pre-keep observations."""
    previous = ctx.goal_coverage
    if previous is None:
        return
    pool_ids = {item.id for item in ctx.pool}
    qualifications = [
        item
        for item in ctx.qualifications.values()
        if item.eligibility != "eligible" or item.candidate_id in pool_ids
    ]
    markets_by_id = {item.id: item.country_code for item in ctx.pool if item.country_code}
    ctx.goal_coverage = assess_goal_coverage(
        qualifications,
        goal_version=ctx.mission.goal.goal_version,
        minimum_eligible=ctx.limits.minimum_eligible,
        search_attempt_count=ctx.search_count,
        request_count=ctx.request_count,
        request_budget=ctx.limits.max_total_requests,
        remaining_time_ms=ctx.remaining_time_ms(),
        model_call_count=ctx.model_call_count,
        model_call_budget=ctx.limits.max_model_calls,
        estimated_token_count=ctx.estimated_token_count,
        token_budget=ctx.limits.max_estimated_tokens,
        marginal_unique_observations=ctx.marginal_unique_observations,
        marginal_eligible_count=ctx.marginal_eligible_count,
        consecutive_no_gain=ctx.consecutive_no_gain,
        requested_markets=list(ctx.mission.goal.retrieval_scope.markets_requested),
        eligible_markets=[
            markets_by_id.get(item.candidate_id, "")
            for item in qualifications
            if item.eligibility == "eligible"
        ],
        preference_evidence_coverage=previous.preference_evidence_coverage,
    )


def _preserve_feasible_coverage(
    ctx: ResearchContext,
    qualified: list,
    selected: list,
) -> list:
    """The model may prioritize feasible products, but cannot invalidate the code-owned gate."""
    if not qualified:
        return selected
    out = list(selected)
    selected_ids = {item.id for item in out}
    requested = set(ctx.mission.goal.retrieval_scope.markets_requested)
    represented = {item.country_code for item in out if item.country_code}
    for item in qualified:
        if item.id in selected_ids:
            continue
        needs_market = bool(item.country_code in requested and item.country_code not in represented)
        needs_minimum = len(out) < min(ctx.limits.minimum_eligible, len(qualified))
        if not (needs_market or needs_minimum):
            continue
        out.append(item)
        selected_ids.add(item.id)
        if item.country_code:
            represented.add(item.country_code)
    return out


async def _next_query(ctx: ResearchContext, backend: ModelBackend | None) -> str | None:
    if backend is not None and backend.is_configured():
        decision = await rewrite_query(backend, ctx)
        if decision.decided:
            proposed = parse_rewrite(decision, ctx)
            if proposed:
                return proposed
            if ctx.goal_coverage is None:
                return None
    if ctx.plan.budget_cny is not None and not ctx.relaxed_native_cap:
        return _deterministic_rewrite(ctx)
    if not ctx.pool and set(ctx.plan.markets) != set(DEFAULT_MARKETS):
        return _deterministic_rewrite(ctx)
    if ctx.search_count < len(ctx.plan.query_variants):
        planned = ctx.plan.query_variants[ctx.search_count]
        if planned and planned not in {ctx.current_query, *ctx.rewritten_queries}:
            return planned
    return _deterministic_rewrite(ctx)


def _deterministic_rewrite(ctx: ResearchContext) -> str | None:
    if ctx.plan.budget_cny is not None and not ctx.relaxed_native_cap:
        ctx.relaxed_native_cap = True
        ctx.add_warnings("原币预算上限下召回不足，已放宽检索，仍按人民币预算过滤")
        return ctx.current_query
    current = list(ctx.plan.markets)
    widened = list(DEFAULT_MARKETS)
    if current and set(current) != set(widened):
        requested = list(ctx.mission.goal.retrieval_scope.markets_requested)
        if requested:
            ctx.proposals.append(
                ResearchProposal(
                    proposal_id=str(uuid4()),
                    kind="expand_markets",
                    reason_code="insufficient_coverage_in_requested_markets",
                    payload={"from": current, "to": widened},
                )
            )
            ctx.add_warnings("指定市场内覆盖不足；已提出扩市场建议，等待用户确认")
            return None
        ctx.plan = ctx.plan.model_copy(update={"markets": widened})
        ctx.query_trace.append(
            ResearchQueryTrace(
                query=ctx.current_query,
                markets=widened,
                purpose=QueryPurpose.MARKET_EXPANSION,
                search_index=ctx.search_count,
            )
        )
        ctx.add_warnings("召回不足，已扩大到默认市场")
        return ctx.current_query
    return None


async def _finalize_ranked(
    ctx: ResearchContext,
    tools: ResearchTools,
    backend: ModelBackend | None,
) -> None:
    if not ctx.pool:
        ctx.ranked = []
        ctx.finalized = True
        return

    # Phase 5: the model may propose recall/semantic keep decisions, but final
    # ordering is code-owned and reproducible from Goal + observed evidence.
    del backend
    ctx.products = list(ctx.pool)
    await tools.run(ToolCall(id="rank", name="rank_candidates", arguments={}), ctx)
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
    original_count = len(ctx.ranked)
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
    ctx.ranked = [
        by_id[str(item["snapshot_id"])] for item in picked if str(item["snapshot_id"]) in by_id
    ]
    if original_count > len(ctx.ranked):
        ctx.add_warnings(
            f"召回过滤后仍有 {original_count} 件，已按市场、形态、商户和商品实体选择前 {len(ctx.ranked)} 件供对照"
        )
