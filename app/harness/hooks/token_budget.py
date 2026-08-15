from __future__ import annotations

import os
from typing import Any


DEFAULT_TOKEN_BUDGET = int(os.environ.get("HARNESS_TOKEN_BUDGET", "12000"))
DEFAULT_WARN_THRESHOLD = int(os.environ.get("HARNESS_TOKEN_WARN_THRESHOLD", "2000"))


async def init_budget(context: dict[str, Any]) -> dict[str, Any] | None:
    return {
        "token_budget": int(context.get("token_budget") or DEFAULT_TOKEN_BUDGET),
        "token_warn_threshold": int(
            context.get("token_warn_threshold") or DEFAULT_WARN_THRESHOLD
        ),
    }


async def inject_budget_hint(context: dict[str, Any]) -> dict[str, Any] | None:
    remaining = _remaining_tokens(context)
    threshold = int(context.get("token_warn_threshold") or DEFAULT_WARN_THRESHOLD)
    if remaining is None or remaining > threshold:
        return None
    return {
        "budget_hint": (
            f"Token 预算剩余约 {remaining}，优先收敛，避免展开低价值候选。"
        )
    }


async def check_budget(context: dict[str, Any]) -> dict[str, Any] | None:
    remaining = _remaining_tokens(context)
    threshold = int(context.get("token_warn_threshold") or DEFAULT_WARN_THRESHOLD)
    if remaining is None or remaining > threshold:
        return None
    return {"needs_compression": True, "remaining_tokens": remaining}


def _remaining_tokens(context: dict[str, Any]) -> int | None:
    if "remaining_tokens" in context:
        try:
            return int(context["remaining_tokens"])
        except (TypeError, ValueError):
            return None

    token_budget = int(context.get("token_budget") or DEFAULT_TOKEN_BUDGET)
    messages = context.get("messages") or context.get("trajectory") or []
    approx_used = sum(len(str(message)) for message in messages) // 4
    return max(0, token_budget - approx_used)
