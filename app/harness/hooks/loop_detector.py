from __future__ import annotations

from collections import deque
from typing import Any


_recent_tools: deque[str] = deque(maxlen=6)
REPEAT_THRESHOLD = 4


async def detect_loop(context: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = context.get("last_tool_name")
    if tool_name:
        _recent_tools.append(str(tool_name))
        if _recent_tools.count(str(tool_name)) >= REPEAT_THRESHOLD:
            _recent_tools.clear()
            inject_messages = list(context.get("inject_messages") or [])
            inject_messages.append({
                "role": "system",
                "content": (
                    f"你已重复调用 {tool_name} 工具 {REPEAT_THRESHOLD} 次，"
                    "请基于已有信息直接给出结论，或换一种思路。"
                ),
            })
            return {"_loop_detected": True, "inject_messages": inject_messages}

    history = context.get("tool_history") or context.get("trajectory") or []
    if len(history) < 3:
        return None

    names = [_tool_name(item) for item in history[-3:]]
    if names[0] and len(set(names)) == 1:
        return {
            "_loop_detected": True,
            "control_hint": f"连续 3 次调用 {names[0]}，请切换策略或收敛输出。",
        }
    return None


def _tool_name(item: Any) -> str | None:
    if isinstance(item, dict):
        value = item.get("tool_name") or item.get("name")
        return str(value) if value else None
    value = getattr(item, "name", None)
    return str(value) if value else None
