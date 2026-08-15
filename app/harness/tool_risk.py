from __future__ import annotations

from enum import Enum


class ToolRisk(Enum):
    READ_ONLY = "read_only"
    WRITE = "write"
    RESOURCE_HEAVY = "resource_heavy"


TOOL_RISK_MAP: dict[str, ToolRisk] = {
    "item_search": ToolRisk.READ_ONLY,
    "category_insight": ToolRisk.READ_ONLY,
    "web_search": ToolRisk.READ_ONLY,
    "price_compare": ToolRisk.READ_ONLY,
    "shipping_calc": ToolRisk.READ_ONLY,
    "planner": ToolRisk.READ_ONLY,
    "chat_fallback": ToolRisk.READ_ONLY,
    "item_picker": ToolRisk.READ_ONLY,
    "shopping_summary": ToolRisk.WRITE,
    "dispatch_tool": ToolRisk.RESOURCE_HEAVY,
}


def get_tool_risk(tool_name: str) -> ToolRisk:
    return TOOL_RISK_MAP.get(tool_name, ToolRisk.READ_ONLY)
