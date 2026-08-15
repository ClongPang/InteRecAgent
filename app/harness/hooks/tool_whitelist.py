from __future__ import annotations

from typing import Any

from app.harness.middleware import HookRejectSignal


DEFAULT_ALLOWED_TOOLS = {
    "planner",
    "chat_fallback",
    "web_search",
    "category_insight",
    "item_search",
    "item_picker",
    "price_compare",
    "shipping_calc",
    "shopping_summary",
    "dispatch_tool",
}


async def check_tool_whitelist(context: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = str(context.get("tool_name") or "")
    if not tool_name:
        raise HookRejectSignal("missing tool_name")

    allowed_tools = set(context.get("allowed_tools") or DEFAULT_ALLOWED_TOOLS)
    if tool_name not in allowed_tools:
        raise HookRejectSignal(f"tool {tool_name} is not allowed")
    return None
