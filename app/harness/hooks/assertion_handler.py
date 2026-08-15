from __future__ import annotations

from contextlib import suppress
from typing import Any

from app.observability.trace_ctx import get_langfuse_trace


async def handle_failed_assertions(context: dict[str, Any]) -> dict[str, Any] | None:
    """Summarize assertion failures and inject corrective system messages."""
    failures = list(context.get("assertions_failed") or [])
    if not failures:
        return None

    schema_fails = [item for item in failures if item.get("type") == "schema"]
    sequencing_fails = [item for item in failures if item.get("type") == "sequencing"]
    semantic_fails = [item for item in failures if item.get("type") == "semantic"]

    messages: list[str] = []
    if schema_fails:
        first = schema_fails[0]
        messages.append(
            f"[格式问题] {first.get('tool')} 的返回格式不符合预期："
            f"{first.get('reason')}。请检查工具参数是否正确。"
        )
    if sequencing_fails:
        messages.append(str(sequencing_fails[0].get("reason")))
    if semantic_fails:
        first = semantic_fails[0]
        messages.append(
            f"[相关性问题] {first.get('tool')} 的返回和用户需求不太对齐。"
            "考虑调整搜索词或换一个检索方向。"
        )

    _record_assertion_failures(context, failures)

    injected = list(context.get("inject_messages") or [])
    injected.extend({"role": "system", "content": message} for message in messages)
    return {"inject_messages": injected, "assertions_failed": []}


def _record_assertion_failures(
    context: dict[str, Any],
    failures: list[dict[str, Any]],
) -> None:
    trace = get_langfuse_trace()
    if not trace:
        return

    with suppress(Exception):
        if hasattr(trace, "event"):
            trace.event(
                name="assertion_failures",
                input={
                    "failures": failures,
                    "round": context.get("round_number", 0),
                },
            )
