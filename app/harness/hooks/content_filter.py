from __future__ import annotations

import re
from typing import Any


SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?([^'\"\s]+)"),
    re.compile(r"sk-[A-Za-z0-9_-]{12,}"),
]


def sanitize_text(text: str) -> str:
    cleaned = text
    for pattern in SECRET_PATTERNS:
        cleaned = pattern.sub(_redact_match, cleaned)
    return cleaned


def _redact_match(match: re.Match[str]) -> str:
    if len(match.groups()) >= 2:
        return match.group(0).split(match.group(2), 1)[0] + "[REDACTED]"
    return "[REDACTED]"


async def filter_tool_output(context: dict[str, Any]) -> dict[str, Any] | None:
    result = context.get("tool_result")
    if not isinstance(result, str):
        return None

    sanitized = sanitize_text(result)
    if sanitized == result:
        return None
    return {"tool_result": sanitized, "tool_result_sanitized": True}
