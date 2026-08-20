"""研究工具目录：暴露给 LLM 的工具签名 + 确定性执行器。

每个执行器包装共享流水线（services/rec/pipeline.py），把硬约束焊死在工具内部：
- ``filter_candidates`` 在过滤前自动补齐汇率换算，保证「FX→预算」顺序不被 LLM 打乱；
- 库存事实判定、排除项、否定候选都在流水线内完成。
因此无论 LLM 以何种顺序调用工具，事实层结果都正确、可审计。
"""
from __future__ import annotations

from typing import Any

from ...application.dto import ToolCall, ToolSpec
from ...application.ports import FxSource, ProductSource, RunProgress
from ...application.services.rec import (
    market_native_caps,
    normalize_products,
    run_filter,
    run_fx,
    run_rank,
    run_search,
)
from .context import ResearchContext

_MARKET_ENUM = ["US", "SG", "VN", "TH", "MY"]


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
        mode = args.get("mode") if args.get("mode") in {"keyword", "hybrid"} else ctx.plan.mode
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
        )
        ctx.products = list(outcome.products)
        ctx.recall_count = len(ctx.products)
        ctx.failed_markets = list(outcome.failed_markets)
        ctx.searched = True
        ctx.converted = False
        ctx.ranked = []
        ctx.add_warnings(outcome.warnings)
        return {
            "found": len(ctx.products),
            "markets": markets,
            "failed_markets": ctx.failed_markets,
            "native_caps": caps,
            "sample": [_brief(p) for p in ctx.products[:5]],
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

    async def _filter_candidates(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        del args
        if not ctx.converted:
            await self._convert_fx(ctx, {})
        belief = ctx.mission.belief
        products, warnings = run_filter(
            ctx.mission.constraints,
            ctx.products,
            rejected_snapshot_ids=set(getattr(belief, "rejected_snapshot_ids", []) or []),
            rejected_listing_keys=set(getattr(belief, "rejected_listing_keys", []) or []),
            snapshot_map={},
        )
        ctx.products = products
        ctx.add_warnings(warnings)
        return {"kept": len(products), "warnings": warnings}

    async def _rank_candidates(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        del args
        if not ctx.converted:
            await self._convert_fx(ctx, {})
        ranked, warnings = run_rank(ctx.mission, ctx.products, snapshot_map={})
        ctx.ranked = ranked
        ctx.add_warnings(warnings)
        return {"ranked": [_brief(p) for p in ranked[:5]], "count": len(ranked)}

    async def _finalize(self, ctx: ResearchContext, args: dict[str, Any]) -> dict[str, Any]:
        ctx.finalized = True
        return {"ok": True, "ranked_count": len(ctx.ranked), "reason": args.get("reason")}
