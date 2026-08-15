from __future__ import annotations

import os
from typing import Any

from app.api.context import UserTier, get_thread_id, get_user_tier
from app.harness.middleware import HookRejectSignal
from app.harness.phase_machine import Phase, phase_machine
from app.harness.tool_risk import ToolRisk, get_tool_risk
from app.harness.user_tool_filter import get_user_restricted_tools
from app.observability.trace_ctx import get_langfuse_trace


MAX_FORK_DEPTH = int(os.environ.get("HARNESS_MAX_FORK_DEPTH", "2"))
MAX_CONCURRENT_FORKS = int(os.environ.get("HARNESS_MAX_CONCURRENT_FORKS", "4"))


async def check_phase_permission(context: dict[str, Any]) -> dict[str, Any] | None:
    """Reject tool calls that are not allowed in the current phase."""
    tool_name = str(context.get("tool_name") or "")
    thread_id = _thread_id(context)

    if not phase_machine.is_tool_allowed(tool_name, thread_id):
        current_phase = phase_machine.get_current_phase(thread_id)
        allowed = phase_machine.get_allowed_tools(thread_id)
        _record_tool_rejected_by_phase(tool_name, current_phase, allowed)
        raise HookRejectSignal(
            f"工具 {tool_name} 在当前阶段 {current_phase.value} 不可用。"
            f"当前可用工具：{', '.join(sorted(allowed))}"
        )

    risk = get_tool_risk(tool_name)
    if risk is ToolRisk.WRITE and phase_machine.get_current_phase(thread_id) is not Phase.CONCLUDING:
        raise HookRejectSignal(f"写入类工具 {tool_name} 只能在 concluding 阶段调用")

    if risk is ToolRisk.RESOURCE_HEAVY:
        fork_depth = int(context.get("fork_depth") or 0)
        active_forks = int(context.get("active_forks") or 0)
        max_fork_depth = int(context.get("max_fork_depth") or MAX_FORK_DEPTH)
        max_concurrent_forks = int(
            context.get("max_concurrent_forks") or MAX_CONCURRENT_FORKS
        )
        if fork_depth >= max_fork_depth:
            raise HookRejectSignal(
                f"资源消耗类工具 {tool_name} 已达到 fork 深度上限 {max_fork_depth}"
            )
        if active_forks >= max_concurrent_forks:
            raise HookRejectSignal(
                f"资源消耗类工具 {tool_name} 已达到并发上限 {max_concurrent_forks}"
            )

    return None


async def check_user_tier_permission(context: dict[str, Any]) -> dict[str, Any] | None:
    """Reject tools that are unavailable for the current user tier."""
    tool_name = str(context.get("tool_name") or "")
    user_tier = _user_tier(context)
    restricted = get_user_restricted_tools(user_tier)

    if tool_name in restricted:
        raise HookRejectSignal(
            f"工具 {tool_name} 对 {user_tier} 用户不可用。"
            "请升级到付费版本以使用跨平台并行检索功能。"
        )

    return None


def _thread_id(context: dict[str, Any]) -> str | None:
    value = context.get("thread_id") or get_thread_id()
    return str(value) if value else None


def _user_tier(context: dict[str, Any]) -> UserTier:
    value = context.get("user_tier")
    if value in {"free", "standard", "premium"}:
        return value
    return get_user_tier()


def _record_tool_rejected_by_phase(
    tool_name: str,
    current_phase: Phase,
    allowed: set[str],
) -> None:
    trace = get_langfuse_trace()
    if not trace:
        return
    try:
        trace.event(
            name="tool_rejected_by_phase",
            input={
                "tool": tool_name,
                "phase": current_phase.value,
                "allowed": sorted(allowed),
            },
        )
    except Exception:
        return
