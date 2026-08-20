"""研究循环控制器：LLM 自主编排驱动 + 确定性驱动（同一套工具，两种驱动）。

- ``run_agent``：LLM 通过原生 tool-calling 自主决定检索/换算/过滤/排序的顺序与重试，
  拿到多跳研究与「无结果放宽软约束重搜」能力（PRD 6.7）。
- ``run_deterministic``：固定顺序调用同一批工具，作为无 Key/降级与安全网。

护栏：最大步数、重复调用去抖、昂贵工具（检索）前的版本探测（尽早放弃过期运行）、
以及循环结束后的安全网——保证无论 LLM 行为如何，都产出一份可交给 commit gate 的结果。
"""
from __future__ import annotations

import json
import logging

from ..application.dto import AssistantTurn, ChatMessage, ToolCall
from ..application.ports import ModelBackend
from ..application.services.rec import VersionProbe, run_filter, run_rank
from .tools import ResearchContext, ResearchTools

logger = logging.getLogger(__name__)

MAX_STEPS = 8

_SYSTEM_PROMPT = """你是跨境购物研究员。目标：为用户找到并排序出可比较的候选商品。

可用工具：search_products（检索）、convert_fx（换算人民币）、filter_candidates（按硬约束过滤）、
rank_candidates（排序）、finalize（结束）。

工作要求：
- 先检索，再换算，再过滤，最后排序；得到满意的排序候选后调用 finalize 结束。
- 若过滤后候选为 0 或过少，放宽查询词或增加市场后重新检索，不要直接放弃。
- 你只负责决定调用哪个工具、传什么参数；价格、库存、汇率、链接等事实由工具返回，不要自己编造。
- 不要重复发起完全相同的调用。"""


def _initial_user(ctx: ResearchContext) -> str:
    c = ctx.mission.constraints
    payload = {
        "query": c.query,
        "budget_cny": c.budget_cny,
        "markets": list(c.markets),
        "preference": c.preference,
        "only_in_stock": c.only_in_stock,
        "excluded_terms": list(c.excluded_terms),
        "default_plan": {"query": ctx.plan.query, "markets": ctx.plan.markets, "mode": ctx.plan.mode},
    }
    return "用户购物约束：" + json.dumps(payload, ensure_ascii=False)


async def run_agent(
    ctx: ResearchContext,
    tools: ResearchTools,
    backend: ModelBackend,
    *,
    max_steps: int = MAX_STEPS,
    version_probe: VersionProbe | None = None,
) -> None:
    messages: list[ChatMessage] = [
        ChatMessage(role="system", content=_SYSTEM_PROMPT),
        ChatMessage(role="user", content=_initial_user(ctx)),
    ]
    seen: set[str] = set()
    for _ in range(max_steps):
        turn = await backend.chat(messages=messages, tools=tools.specs)
        if turn.is_final:
            break
        messages.append(
            ChatMessage(role="assistant", content=turn.content, tool_calls=turn.tool_calls)
        )
        should_stop = False
        for call in turn.tool_calls:
            if call.name == "search_products" and version_probe is not None and await version_probe():
                ctx.stale = True
                return
            result = await _dispatch(tools, ctx, call, seen)
            messages.append(
                ChatMessage(
                    role="tool",
                    tool_call_id=call.id,
                    name=call.name,
                    content=json.dumps(result, ensure_ascii=False),
                )
            )
            if call.name == "finalize":
                should_stop = True
        if should_stop:
            break

    # 安全网：LLM 未产出排序候选（跑满步数 / 半途终止）时，用确定性驱动补全，
    # 保证一定有结果交给 commit gate。运行已过期则不做无谓补全。
    if not ctx.stale and not ctx.ranked:
        await run_deterministic(ctx, tools)


async def _dispatch(
    tools: ResearchTools, ctx: ResearchContext, call: ToolCall, seen: set[str]
) -> dict:
    signature = call.name + ":" + json.dumps(call.arguments or {}, sort_keys=True, ensure_ascii=False)
    if call.name != "finalize" and signature in seen:
        return {"skipped": "duplicate_call"}
    seen.add(signature)
    try:
        return await tools.run(call, ctx)
    except Exception:  # noqa: BLE001 - 单个工具失败不应炸掉整轮，转成可见错误交回模型
        logger.exception("research tool failed", extra={"tool": call.name})
        return {"error": "tool_execution_failed", "tool": call.name}


async def run_deterministic(ctx: ResearchContext, tools: ResearchTools) -> None:
    """固定顺序驱动：检索 → 换算 → 过滤 → 排序。无 Key / 降级 / 安全网复用。"""
    await _run_once(ctx, tools)
    if ctx.ranked:
        ctx.finalized = True
        return
    # PRD 6.7：只放宽软条件。预算硬过滤不抬升；原币上限过窄时允许再召回一次。
    if ctx.plan.budget_cny is not None and ctx.recall_count == 0 and not ctx.relaxed_native_cap:
        ctx.add_warnings(["原币预算上限下无召回，已放宽检索，仍按人民币预算过滤"])
        ctx.searched = False
        ctx.converted = False
        await tools.run(
            ToolCall(id="d-search-relax", name="search_products", arguments={"skip_budget_cap": True}),
            ctx,
        )
        await _run_once(ctx, tools)
        if ctx.ranked:
            ctx.finalized = True
            return
    if ctx.mission.constraints.only_in_stock and ctx.converted_products:
        relaxed = ctx.mission.constraints.model_copy(update={"only_in_stock": False})
        products, warnings = run_filter(
            relaxed,
            ctx.converted_products,
            rejected_snapshot_ids=set(getattr(ctx.mission.belief, "rejected_snapshot_ids", []) or []),
            rejected_listing_keys=set(getattr(ctx.mission.belief, "rejected_listing_keys", []) or []),
        )
        if products:
            ctx.add_warnings(["「仅看有货」导致空集，已按软条件放宽库存过滤"])
            ctx.add_warnings(warnings)
            ctx.products = products
            ranked, rank_warnings = run_rank(ctx.mission, products)
            ctx.ranked = ranked
            ctx.add_warnings(rank_warnings)
    ctx.finalized = True


async def _run_once(ctx: ResearchContext, tools: ResearchTools) -> None:
    if not ctx.searched:
        await tools.run(ToolCall(id="d-search", name="search_products", arguments={}), ctx)
    if not ctx.converted:
        await tools.run(ToolCall(id="d-fx", name="convert_fx", arguments={}), ctx)
    await tools.run(ToolCall(id="d-filter", name="filter_candidates", arguments={}), ctx)
    await tools.run(ToolCall(id="d-rank", name="rank_candidates", arguments={}), ctx)


def _empty_turn() -> AssistantTurn:  # pragma: no cover - 便于测试构造终稿
    return AssistantTurn(content="done")
