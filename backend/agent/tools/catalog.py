"""研究工具目录：暴露给 LLM 的工具签名 + 确定性执行器。

每个执行器包装共享流水线（services/rec/pipeline.py），把硬约束焊死在工具内部：
- ``filter_candidates`` 在过滤前自动补齐汇率换算，保证「FX→预算」顺序不被 LLM 打乱；
- 库存事实判定、排除项、否定候选都在流水线内完成。
因此无论 LLM 以何种顺序调用工具，事实层结果都正确、可审计。
"""

from __future__ import annotations

from typing import Any

from ...application.dto import ToolCall, ToolSpec
from ...application.dto.belief import SpecGate
from ...application.dto.research import QueryPurpose, ResearchQueryTrace
from ...application.errors import UpstreamUnavailableError
from ...application.ports import FxSource, ProductSource, RunProgress
from ...application.services.goal import constraint_view_from_goal, ensure_goal_authority
from ...application.services.model_context import catalog_stats
from ...application.services.rec import (
    assess_goal_coverage,
    market_native_caps,
    normalize_products,
    rec_state_from_mission,
    run_filter,
    run_fx,
    run_rank,
    run_search,
)
from ...application.services.rec.qualify import qualify_product
from ...domain.models import NormalizedProduct
from ...domain.policies.score import dimension_matches, title_matches_preference
from .context import ResearchContext

_MARKET_ENUM = ["US", "SG", "VN", "TH", "MY"]


def _preference_evidence_coverage(ctx: ResearchContext) -> dict[str, float]:
    rec = rec_state_from_mission(ctx.mission)
    products = {
        item.id: item for item in [*ctx.pool, *ctx.products, *ctx.evidence_candidates.values()]
    }
    eligible = [
        products[item.candidate_id]
        for item in ctx.qualifications.values()
        if item.eligibility == "eligible" and item.candidate_id in products
    ]
    if not eligible:
        return {}
    result: dict[str, float] = {}
    if rec.preference in {"battery", "noise"}:
        hits = sum(title_matches_preference(item, rec.preference) for item in eligible)
        result[rec.preference] = round(hits / len(eligible), 4)
    for attr, _direction, status, cues in rec.soft_prefs:
        if status != "active" or attr in {"price", "weight"}:
            continue
        hits = sum(dimension_matches(item, attr=attr, cues=cues) for item in eligible)
        result[attr] = round(hits / len(eligible), 4)
    return result


def _brief(product: Any) -> dict[str, Any]:
    return {
        "id": product.id,
        "title": product.title,
        "merchant": product.merchant,
        "market": product.country_code,
        "native_price": product.native_price_amount,
        "currency": product.native_currency,
        "rmb_price": product.rmb_price,
        "fx_failed": product.fx_failed,
        "in_stock": product.in_stock,
    }


class ResearchTools:
    """把确定性流水线暴露成 LLM 可调用的工具集合。"""

    def __init__(
        self,
        products: ProductSource,
        fx: FxSource,
        *,
        max_concurrency: int = 3,
        progress: RunProgress | None = None,
    ) -> None:
        self._products = products
        self._fx = fx
        self._max_concurrency = max_concurrency
        self._progress = progress

    @property
    def specs(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                name="search_products",
                description=(
                    "按查询词与市场检索候选商品。无结果或结果太少时可放宽查询词或增加市场后重试。"
                    "不传参数则使用当前任务的检索计划。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "检索词；留空用任务默认"},
                        "markets": {
                            "type": "array",
                            "items": {"type": "string", "enum": _MARKET_ENUM},
                        },
                        "mode": {"type": "string", "enum": ["keyword", "hybrid"]},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                        "skip_budget_cap": {
                            "type": "boolean",
                            "description": "为 true 时不传原币预算上限（召回放宽，仍按人民币预算过滤）",
                        },
                    },
                },
            ),
            ToolSpec(
                name="convert_fx",
                description="把候选商品的原币价换算成人民币；失败币种保留原币。过滤前必须完成。",
            ),
            ToolSpec(
                name="filter_candidates",
                description=(
                    "按硬约束过滤候选：预算、仅看有货、排除项、已否定项。"
                    "会自动先完成汇率换算。返回保留数量与被过滤原因。"
                ),
            ),
            ToolSpec(
                name="rank_candidates",
                description="按预算/偏好/信念对当前候选做多目标排序，返回排序后的候选 ID。",
            ),
            ToolSpec(
                name="finalize",
                description="当已得到满意的排序候选时结束研究；后续由确定性证据校验与落库处理。",
                parameters={
                    "type": "object",
                    "properties": {"reason": {"type": "string"}},
                },
            ),
        ]

    async def run(self, call: ToolCall, ctx: ResearchContext) -> dict[str, Any]:
        handler = {
            "search_products": self._search_products,
            "convert_fx": self._convert_fx,
            "filter_candidates": self._filter_candidates,
            "rank_candidates": self._rank_candidates,
            "finalize": self._finalize,
        }.get(call.name)
        if handler is None:
            return {"error": f"unknown_tool:{call.name}"}
        args = call.arguments or {}
        await self._emit_started(call.name, args, ctx)
        result = await handler(ctx, args)
        await self._emit_finished(call.name, result)
        return result

    async def _emit_started(self, tool: str, args: dict[str, Any], ctx: ResearchContext) -> None:
        if self._progress is None or tool != "search_products":
            return
        query = str(args.get("query") or ctx.plan.query or "")
        markets = [m for m in (args.get("markets") or ctx.plan.markets) if m]
        await self._progress.started(
            tool, {"query": query, "markets": markets or list(ctx.plan.markets)}
        )

    async def _emit_finished(self, tool: str, result: dict[str, Any]) -> None:
        if self._progress is None:
            return
        if tool == "search_products":
            await self._progress.finished(
                tool,
                {
                    "count": result.get("found", 0),
                    "markets": result.get("markets") or [],
                    "failed_markets": result.get("failed_markets") or [],
                },
            )
            return
        if tool == "convert_fx":
            await self._progress.finished(
                tool,
                {"converted": result.get("converted") or [], "failed": result.get("failed") or []},
            )
            return
        if tool == "rank_candidates":
            await self._progress.finished(tool, {"count": result.get("count", 0)})

    async def _search_products(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("query") or ctx.plan.query or "")
        markets = [m for m in (args.get("markets") or ctx.plan.markets) if m in _MARKET_ENUM]
        markets = markets or list(ctx.plan.markets)
        remaining_requests = ctx.limits.max_total_requests - ctx.request_count
        if remaining_requests <= 0:
            ctx.stop_reason = "request_budget_exhausted"
            return {"found": 0, "error": "request_budget_exhausted"}
        markets = markets[:remaining_requests]
        mode = str(args.get("mode") if args.get("mode") in {"keyword", "hybrid"} else ctx.plan.mode)
        limit = int(args.get("limit") or ctx.plan.limit)
        skip_cap = bool(args.get("skip_budget_cap"))
        caps: dict[str, float] = {}
        if ctx.plan.budget_cny is not None and not skip_cap:
            caps, cap_failed = await market_native_caps(self._fx, markets, ctx.plan.budget_cny)
            if cap_failed:
                ctx.add_warnings(
                    f"以下币种汇率暂不可用，对应市场未设原币预算上限：{'、'.join(cap_failed)}"
                )
        if skip_cap:
            ctx.relaxed_native_cap = True
        outcome = await run_search(
            self._products,
            query=query,
            markets=markets,
            mode=mode,
            limit=limit,
            max_concurrency=self._max_concurrency,
            max_prices=caps or None,
            goal_version=ctx.mission.goal.goal_version,
        )
        ctx.products = list(outcome.products)
        ctx.request_count += len(outcome.executions)
        ctx.search_executions.extend(outcome.executions)
        for observation in outcome.observations:
            ctx.product_observations[observation.source_product_id] = observation
        ctx.batch = []
        ctx.recall_count = len(ctx.products)
        ctx.failed_markets = list(outcome.failed_markets)
        ctx.searched = True
        ctx.converted = False
        ctx.add_warnings(outcome.warnings)
        rec = rec_state_from_mission(ctx.mission)
        stats = catalog_stats(
            ctx.products,
            gates=[
                SpecGate(attr=attr, cues=list(cues), required=required)
                for attr, cues, required in rec.spec_gates
            ],
            found=len(ctx.products),
        )
        return {
            "found": len(ctx.products),
            "markets": markets,
            "failed_markets": ctx.failed_markets,
            "native_caps": caps,
            **stats.as_payload(),
        }

    async def _convert_fx(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        del args
        if not ctx.products:
            ctx.converted = True
            return {"converted": [], "failed": [], "note": "no_products"}
        rates, failed = await run_fx(self._fx, ctx.products)
        ctx.rates = rates
        ctx.fx_failed_currencies = failed
        ctx.products = normalize_products(ctx.products, rates)
        ctx.converted_products = list(ctx.products)
        ctx.converted = True
        return {
            "converted": sorted(rates.keys()),
            "failed": failed,
            "sample": [_brief(p) for p in ctx.products[:5]],
        }

    async def _filter_candidates(
        self, ctx: ResearchContext, args: dict[str, Any]
    ) -> dict[str, Any]:
        del args
        if not ctx.converted:
            await self._convert_fx(ctx, {})
        rec = rec_state_from_mission(ctx.mission)
        spec_gates = [
            SpecGate(attr=attr, cues=list(cues), required=required)
            for attr, cues, required in rec.spec_gates
        ]
        if ctx.mission.goal.target.item_type in ctx.enabled_item_types:
            for product in ctx.products:
                if product.country_code:
                    ctx.candidate_markets[product.id] = product.country_code
                qualification = qualify_product(product, ctx.mission.goal)
                ctx.qualifications[product.id] = qualification
                if qualification.eligibility == "needs_evidence":
                    ctx.evidence_candidates[product.id] = product
            ctx.goal_coverage = assess_goal_coverage(
                list(ctx.qualifications.values()),
                goal_version=ctx.mission.goal.goal_version,
                minimum_eligible=ctx.limits.minimum_eligible,
                search_attempt_count=ctx.search_count + 1,
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
                    ctx.candidate_markets.get(item.candidate_id, "")
                    for item in ctx.qualifications.values()
                    if item.eligibility == "eligible"
                ],
                preference_evidence_coverage=_preference_evidence_coverage(ctx),
            )
        canonical_goal = ensure_goal_authority(
            ctx.mission.goal,
            ctx.mission.constraints,
            version=max(ctx.mission.goal.goal_version, ctx.mission.constraints_version),
            belief=ctx.mission.belief,
        )
        products, warnings = run_filter(
            constraint_view_from_goal(canonical_goal, fallback=ctx.mission.constraints),
            ctx.products,
            rejected_snapshot_ids=set(rec.rejected_snapshot_ids),
            rejected_listing_keys=set(rec.rejected_listing_keys),
            spec_gates=spec_gates,
            snapshot_map={},
            goal=canonical_goal,
            enabled_item_types=ctx.enabled_item_types,
        )
        ctx.products = products
        ctx.batch = list(products)
        ctx.add_warnings(warnings)
        stats = catalog_stats(products, gates=spec_gates)
        return {
            "kept": len(products),
            "warnings": warnings,
            "coverage": ctx.goal_coverage.model_dump(mode="json") if ctx.goal_coverage else None,
            **stats.as_payload(),
        }

    async def supplement_evidence(self, ctx: ResearchContext) -> list[NormalizedProduct]:
        """Fetch details only for candidates blocked by missing evidence."""
        remaining_requests = max(0, ctx.limits.max_total_requests - ctx.request_count)
        recall_reserve = (
            min(len(ctx.plan.markets), remaining_requests)
            if ctx.search_count + 1 < ctx.limits.max_searches
            else 0
        )
        evidence_budget = max(0, remaining_requests - recall_reserve)
        pending = [
            product
            for product_id, product in ctx.evidence_candidates.items()
            if product_id not in ctx.evidence_attempted_ids
        ][: min(ctx.limits.max_evidence_fetches, evidence_budget)]
        enriched: list[NormalizedProduct] = []
        for original in pending:
            if ctx.request_count >= ctx.limits.max_total_requests:
                ctx.stop_reason = "request_budget_exhausted"
                break
            if ctx.wall_time_exhausted():
                ctx.stop_reason = "time_budget_exhausted"
                break
            ctx.evidence_attempted_ids.add(original.id)
            ctx.query_trace.append(
                ResearchQueryTrace(
                    query=f"detail:{original.id}",
                    markets=[original.country_code] if original.country_code else [],
                    purpose=QueryPurpose.EVIDENCE_SUPPLEMENT,
                    search_index=ctx.search_count,
                )
            )
            try:
                ctx.request_count += 1
                detail_observation = None
                detail_capability = getattr(self._products, "get_product_with_observation", None)
                if callable(detail_capability):
                    detailed = await detail_capability(original.id)
                    if detailed is None:
                        detail = None
                    else:
                        detail, detail_observation = detailed
                else:
                    detail = await self._products.get_product(original.id)
            except UpstreamUnavailableError as exc:
                ctx.add_warnings(f"商品 {original.id} 详情补证失败：{exc.code}")
                continue
            if detail is None:
                continue
            if detail_observation is not None:
                ctx.product_observations[detail.id] = detail_observation.model_copy(
                    update={"goal_version": ctx.mission.goal.goal_version}
                )
            detail = detail.model_copy(
                update={
                    "rmb_price": original.rmb_price,
                    "fx_as_of": original.fx_as_of,
                    "fx_failed": original.fx_failed,
                }
            )
            qualification = qualify_product(detail, ctx.mission.goal)
            if detail.country_code:
                ctx.candidate_markets[detail.id] = detail.country_code
            ctx.qualifications[detail.id] = qualification
            ctx.evidence_candidates[detail.id] = detail
            if qualification.eligibility == "eligible":
                enriched.append(detail)
        if ctx.qualifications:
            ctx.goal_coverage = assess_goal_coverage(
                list(ctx.qualifications.values()),
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
                    ctx.candidate_markets.get(item.candidate_id, "")
                    for item in ctx.qualifications.values()
                    if item.eligibility == "eligible"
                ],
                preference_evidence_coverage=_preference_evidence_coverage(ctx),
            )
        return enriched

    async def _rank_candidates(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        del args
        if not ctx.converted:
            await self._convert_fx(ctx, {})
        ranked, warnings = run_rank(ctx.mission, ctx.products, snapshot_map={}, limit=None)
        ctx.ranked = ranked
        ctx.add_warnings(warnings)
        rec = rec_state_from_mission(ctx.mission)
        gates = [
            SpecGate(attr=attr, cues=list(cues), required=required)
            for attr, cues, required in rec.spec_gates
        ]
        stats = catalog_stats(ranked, gates=gates)
        return {"count": len(ranked), "ranked": stats.sample, **stats.as_payload()}

    async def emit_ranked(self, count: int) -> None:
        await self._emit_finished("rank_candidates", {"count": count})

    async def _finalize(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        ctx.finalized = True
        return {"ok": True, "ranked_count": len(ctx.ranked), "reason": args.get("reason")}
