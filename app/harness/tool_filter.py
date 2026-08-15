from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from app.agent.tool_registry import FULL_TOOL_SET
from app.api.context import UserTier
from app.harness.user_tool_filter import get_user_filtered_tools


def get_filtered_tool_set(
    thread_id: str | None = None,
    tools: Iterable[Any] | None = None,
    user_tier: UserTier | None = None,
) -> list[Any]:
    """Return tools visible to the model for the current phase and user tier."""
    allowed = get_user_filtered_tools(user_tier=user_tier, thread_id=thread_id)
    candidates = list(FULL_TOOL_SET if tools is None else tools)
    return [tool for tool in candidates if _tool_name(tool) in allowed]


def get_filtered_tool_names(
    thread_id: str | None = None,
    user_tier: UserTier | None = None,
) -> list[str]:
    return [
        _tool_name(tool)
        for tool in get_filtered_tool_set(thread_id=thread_id, user_tier=user_tier)
    ]


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", tool))
