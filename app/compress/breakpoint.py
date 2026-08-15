from __future__ import annotations

from typing import Any, Sequence


Message = dict[str, Any]
TOOL_MESSAGE_TYPES = {"tool", "tool_result"}


def compute_breakpoint(
    messages: Sequence[Message],
    keep_recent: int = 3,
) -> int:
    """Return the Cache Breakpoint index for a message list.

    Messages before the returned index are treated as the stable prompt-cache
    prefix. Messages from the returned index onward are the dynamic area where
    tool results can be shortened without mutating the cached prefix.
    """
    if keep_recent <= 0:
        return 0

    tool_call_indices = [
        i for i, message in enumerate(messages)
        if _message_type(message) in TOOL_MESSAGE_TYPES
    ]

    if len(tool_call_indices) <= keep_recent:
        return len(messages)

    return tool_call_indices[-keep_recent]


def find_cache_breakpoint(
    messages: Sequence[Message],
    keep_tail: int = 3,
) -> int:
    """Backward-compatible alias for ``compute_breakpoint``.

    ``keep_tail`` used to mean "keep the last N messages". The document-backed
    implementation now interprets it as the number of recent tool observations
    that define the dynamic suffix.
    """
    return compute_breakpoint(messages, keep_recent=keep_tail)


def split_for_compression(
    messages: Sequence[Message],
    keep_recent: int = 3,
) -> tuple[list[Message], list[Message]]:
    breakpoint_idx = compute_breakpoint(messages, keep_recent=keep_recent)
    return list(messages[:breakpoint_idx]), list(messages[breakpoint_idx:])


def _message_type(message: Any) -> str:
    if isinstance(message, dict):
        value = message.get("type") or message.get("role")
        return str(value or "").lower()

    value = getattr(message, "type", None) or getattr(message, "role", None)
    return str(value or "").lower()
