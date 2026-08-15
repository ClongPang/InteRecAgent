from __future__ import annotations

from typing import Any

from app.harness.middleware import HookRejectSignal


async def validate_tool_args(context: dict[str, Any]) -> dict[str, Any] | None:
    tool_args = context.get("tool_args", {})
    if tool_args is None:
        return {"tool_args": {}}
    if not isinstance(tool_args, dict):
        raise HookRejectSignal("tool_args must be a dict")
    return None
