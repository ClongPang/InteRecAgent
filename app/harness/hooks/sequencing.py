from __future__ import annotations

from collections import defaultdict
from typing import Any

from app.api.context import get_thread_id


PREREQUISITES = {
    "shopping_summary": ["item_picker"],
    "price_compare": ["item_search"],
    "shipping_calc": ["price_compare"],
    "item_picker": ["shipping_calc"],
}

_called_tools_by_thread: dict[str, list[str]] = defaultdict(list)


async def reset_sequence_state(context: dict[str, Any]) -> dict[str, Any] | None:
    thread_id = _thread_id(context)
    _called_tools_by_thread[thread_id] = []
    return None


async def check_sequencing(context: dict[str, Any]) -> dict[str, Any] | None:
    """Warn when a tool is called before its expected prerequisite tools."""
    tool_name = str(context.get("tool_name") or "")
    prerequisites = PREREQUISITES.get(tool_name, [])
    if not prerequisites:
        return None

    called_tools = _called_tools_by_thread[_thread_id(context)]
    missing = [prereq for prereq in prerequisites if prereq not in called_tools]
    if not missing:
        return None

    warning = (
        f"注意：{tool_name} 通常在 {missing[0]} 之后调用，"
        f"但当前 {missing[0]} 尚未执行。"
    )
    warnings = list(context.get("inject_warnings") or [])
    warnings.append(warning)
    failures = list(context.get("assertions_failed") or [])
    failures.append({
        "type": "sequencing",
        "tool": tool_name,
        "reason": warning,
        "missing": missing,
    })
    return {"inject_warnings": warnings, "assertions_failed": failures}


async def record_tool_call(context: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = str(context.get("tool_name") or "")
    if tool_name:
        _called_tools_by_thread[_thread_id(context)].append(tool_name)
    return None


def _thread_id(context: dict[str, Any]) -> str:
    return str(context.get("thread_id") or get_thread_id() or "default")
