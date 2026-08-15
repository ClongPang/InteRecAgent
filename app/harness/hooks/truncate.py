from __future__ import annotations

import os
from typing import Any


DEFAULT_MAX_TOOL_RESULT_CHARS = int(os.environ.get("MAX_TOOL_RESULT_CHARS", "3000"))


async def truncate_tool_result(context: dict[str, Any]) -> dict[str, Any] | None:
    result = context.get("tool_result")
    if result is None:
        return None

    max_chars = int(context.get("max_tool_result_chars") or DEFAULT_MAX_TOOL_RESULT_CHARS)
    text = result if isinstance(result, str) else str(result)
    if len(text) <= max_chars:
        return None

    truncated = text[: max_chars - 200].rstrip()
    truncated += "\n\n[...工具结果过长已截断，如需完整内容请缩小查询范围]"
    return {
        "tool_result": truncated,
        "tool_result_truncated": True,
        "tool_result_original_chars": len(text),
    }
