from __future__ import annotations

from typing import Any

from app.harness.hooks.content_filter import sanitize_text
from app.memory.injector import remember_preferences


async def audit_final_output(context: dict[str, Any]) -> dict[str, Any] | None:
    final_answer = context.get("final_answer")
    if not isinstance(final_answer, str):
        return None

    sanitized = sanitize_text(final_answer)
    if sanitized == final_answer:
        return None
    return {"final_answer": sanitized, "final_answer_sanitized": True}


async def writeback_preferences(context: dict[str, Any]) -> dict[str, Any] | None:
    user_id = context.get("user_id")
    preferences = context.get("learned_preferences") or []
    if not user_id or not preferences:
        return None

    written = await remember_preferences(
        user_id=str(user_id),
        preferences=[str(pref) for pref in preferences],
        source_thread_id=context.get("thread_id"),
    )
    return {"written_preferences": written}
