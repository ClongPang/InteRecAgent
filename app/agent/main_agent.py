import asyncio
import os
import re
import time
from typing import Any

from app.api.context import UserTier, get_session_dir
from app.api.monitor import monitor
from app.compress.context_manager import build_context
from app.harness.middleware import harness
from app.harness.tool_filter import get_filtered_tool_names, get_filtered_tool_set
from app.memory.injector import load_preference_block, maybe_write_preference
from app.observability.langfuse_handler import create_langfuse_handler
from app.agent.prompts import format_dispatch_demands


MAIN_AGENT_MAX_ITERATIONS = int(os.environ.get("MAIN_AGENT_MAX_ITERATIONS", "12"))
MAIN_AGENT_TIMEOUT_SEC = float(os.environ.get("MAIN_AGENT_TIMEOUT_SEC", "30"))


async def run_agent(
    query: str,
    thread_id: str,
    user_id: str | None = None,
    user_tier: UserTier = "free",
    agent: Any | None = None,
) -> dict[str, Any]:
    handler = create_langfuse_handler(thread_id)
    callbacks = [handler] if handler else []

    if agent is None:
        return await _run_bootstrap_loop(
            query,
            thread_id,
            user_id,
            user_tier,
            bool(callbacks),
        )

    session_dir = get_session_dir()
    if user_id:
        await maybe_write_preference(query, user_id, source_thread_id=thread_id)
    preferences = await load_preference_block(user_id, query) if user_id else ""
    messages = build_context(
        thread_id=thread_id,
        session_dir=session_dir,
        current_request=query,
        long_term_preferences=preferences,
    )

    result = await asyncio.wait_for(
        agent.ainvoke(
            {"messages": messages},
            config={
                "configurable": {"thread_id": thread_id},
                "recursion_limit": MAIN_AGENT_MAX_ITERATIONS,
                "callbacks": callbacks,  # 关键：注入 LangFuse
            },
        ),
        timeout=MAIN_AGENT_TIMEOUT_SEC,
    )
    if isinstance(result, dict):
        return result
    return {"final": str(result)}


def get_current_tool_set(user_tier: UserTier | None = None) -> list[Any]:
    """Return the current phase-filtered tool set for a LangGraph Agent build."""
    return get_filtered_tool_set(user_tier=user_tier)


def _build_main_agent(prompt: str, user_tier: UserTier | None = None) -> Any:
    """Build a ReAct agent with tools filtered by the current phase."""
    from langgraph.prebuilt import create_react_agent

    from app.agent.harness_tool_node import HarnessToolNode
    from app.agent.llm import get_llm

    return create_react_agent(
        model=get_llm(),
        tools=HarnessToolNode(get_filtered_tool_set(user_tier=user_tier)),
        prompt=prompt,
    )


async def _run_bootstrap_loop(
    query: str,
    thread_id: str,
    user_id: str | None,
    user_tier: UserTier,
    callbacks_enabled: bool,
) -> dict[str, Any]:
    """Local deterministic loop used before the LangGraph agent is assembled.

    It keeps the HTTP/WebSocket/ContextVar path executable without requiring model
    keys, ANN indexes, or OpenSearch during project initialization.
    """
    t0 = time.time()
    if user_id:
        await maybe_write_preference(query, user_id, source_thread_id=thread_id)
    preferences = await load_preference_block(user_id, query) if user_id else ""

    think_ctx = await harness.run("pre_think", {
        "query": query,
        "thread_id": thread_id,
        "user_id": user_id,
        "user_tier": user_tier,
        "messages": [],
    })
    query = str(think_ctx.get("query", query))

    await monitor.report_assistant_call("thinking", query)
    await monitor.report_tool_start("planner", {"user_query": query})
    plan = _heuristic_plan(query, user_tier)
    await monitor.report_tool_end("planner", int((time.time() - t0) * 1000))

    if len(plan["platforms"]) > 1:
        demands = format_dispatch_demands(
            platform=", ".join(plan["platforms"]),
            category=plan["category"],
            hard_constraints=plan["hard_constraints"],
            soft_preferences=plan["soft_preferences"],
        )
        await monitor.report_fork(
            sub_thread_id=f"sub-{thread_id[:8]}",
            demands=demands,
        )

    final = _format_bootstrap_summary(query, plan, preferences)
    session_dir = get_session_dir()
    return {
        "final": final,
        "query": query,
        "thread_id": thread_id,
        "user_id": user_id,
        "user_tier": user_tier,
        "mode": "bootstrap",
        "plan": plan,
        "session_dir": str(session_dir) if session_dir else None,
        "callbacks_enabled": callbacks_enabled,
    }


def _heuristic_plan(query: str, user_tier: UserTier) -> dict[str, Any]:
    budget = _extract_budget(query)
    hard_constraints = []
    if "不要塑料" in query or "非塑料" in query:
        hard_constraints.append("不要塑料")
    if "便宜" in query or "预算" in query:
        hard_constraints.append("控制预算")

    soft_preferences = []
    if "小众" in query:
        soft_preferences.append("偏好小众款")
    if "抗造" in query or "耐用" in query:
        soft_preferences.append("偏好耐用")

    platforms = ["amazon", "shopee", "aliexpress", "ebay"]
    available_tools = get_filtered_tool_names(user_tier=user_tier)
    return {
        "budget": budget,
        "category": _guess_category(query),
        "hard_constraints": hard_constraints,
        "soft_preferences": soft_preferences,
        "platforms": platforms,
        "available_tools": available_tools,
        "next_tools": [
            "CategoryInsight",
            "dispatch_tool",
            "ItemSearch",
            "PriceCompare",
            "ShippingCalc",
            "ItemPicker",
            "ShoppingSummary",
        ],
    }


def _extract_budget(query: str) -> str | None:
    match = re.search(r"预算\s*([0-9]+(?:\.[0-9]+)?)\s*([元块]|cny|rmb)?", query, re.I)
    if match:
        unit = match.group(2) or "元"
        return f"{match.group(1)}{unit}"
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*([元块])", query)
    if match:
        return f"{match.group(1)}{match.group(2)}"
    return None


def _guess_category(query: str) -> str:
    for marker in ("我想买", "想买", "买一套", "买个", "买"):
        if marker in query:
            return query.split(marker, 1)[1].strip(" ，。")
    return query.strip()


def _format_bootstrap_summary(
    query: str,
    plan: dict[str, Any],
    preferences: str,
) -> str:
    budget_line = f"- 预算: {plan['budget']}" if plan["budget"] else "- 预算: 待确认"
    hard = " / ".join(plan["hard_constraints"]) or "无明确硬约束"
    soft = " / ".join(plan["soft_preferences"]) or "无明确软偏好"
    pref_line = preferences or "暂无长期偏好"
    available = " -> ".join(plan.get("available_tools") or []) or "无"
    return "\n".join([
        "HeartShop 已完成本轮购物意图的工程化拆解。",
        "",
        f"- 原始需求: {query}",
        budget_line,
        f"- 品类候选: {plan['category']}",
        f"- 硬约束: {hard}",
        f"- 软偏好: {soft}",
        f"- 长期偏好: {pref_line}",
        f"- 当前阶段可见工具: {available}",
        f"- 后续工具链: {' -> '.join(plan['next_tools'])}",
        "",
        "当前处于 bootstrap 模式：服务、ContextVar、WebSocket 事件和工具编排骨架可运行；真实检索、比价和摘要生成会在配置模型、ANN 索引、OpenSearch 后切换到完整 AgentLoop。",
    ])
