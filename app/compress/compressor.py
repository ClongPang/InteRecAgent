from __future__ import annotations

from typing import Any, Sequence

from app.compress.breakpoint import Message, TOOL_MESSAGE_TYPES, compute_breakpoint


def summarize_messages(messages: Sequence[Message], max_chars: int = 1200) -> str:
    lines: list[str] = []
    for message in messages:
        role = str(message.get("role") or message.get("type") or "message")
        content = str(message.get("content") or "")
        if content:
            lines.append(f"{role}: {content}")

    summary = "\n".join(lines)
    if len(summary) <= max_chars:
        return summary
    return summary[: max_chars - 20].rstrip() + "\n...(truncated)"


def compress_after_breakpoint(
    messages: Sequence[Message],
    breakpoint_idx: int,
    max_tool_result_chars: int = 2000,
) -> list[Message]:
    """Shorten large tool results after the Cache Breakpoint.

    The prefix before ``breakpoint_idx`` is copied but not mutated, preserving
    byte-stable prompt-cache input. Only the dynamic suffix is eligible for
    lightweight tool-result truncation.
    """
    cached_part = [dict(message) for message in messages[:breakpoint_idx]]
    compressible_part = [dict(message) for message in messages[breakpoint_idx:]]

    compressed: list[Message] = []
    for message in compressible_part:
        content = message.get("content")
        if _is_tool_message(message) and isinstance(content, str):
            if len(content) > max_tool_result_chars:
                message["content"] = (
                    content[:max_tool_result_chars].rstrip()
                    + "\n[...内容已精简]"
                )
                message["compressed"] = True
                message["original_chars"] = len(content)
        compressed.append(message)

    return cached_part + compressed


def compress_context(
    messages: Sequence[Message],
    keep_recent_tools: int = 3,
    max_tool_result_chars: int = 2000,
    *,
    keep_tail: int | None = None,
) -> list[Message]:
    if keep_tail is not None:
        keep_recent_tools = keep_tail
    breakpoint_idx = compute_breakpoint(messages, keep_recent=keep_recent_tools)
    return compress_after_breakpoint(
        messages,
        breakpoint_idx,
        max_tool_result_chars=max_tool_result_chars,
    )


def _is_tool_message(message: Message) -> bool:
    message_type = str(message.get("type") or message.get("role") or "").lower()
    return message_type in TOOL_MESSAGE_TYPES
