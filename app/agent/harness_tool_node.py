from __future__ import annotations

import asyncio
import time
from typing import Any

from langchain_core.messages import ToolMessage
from langgraph.prebuilt import ToolNode

from app.api.context import get_thread_id, get_user_tier
from app.harness.middleware import harness


class HarnessToolNode(ToolNode):
    """ToolNode with pre_tool_call and post_tool_call Harness hooks."""

    async def _arun_one(
        self,
        call: dict[str, Any],
        input_type: str,
        tool_runtime: Any,
    ) -> Any:
        ctx = await harness.run("pre_tool_call", {
            "tool_name": call.get("name"),
            "tool_args": call.get("args") or {},
            "tool_call_id": call.get("id"),
            "thread_id": get_thread_id(),
            "user_tier": get_user_tier(),
        })

        if ctx.get("_rejected"):
            return _rejected_tool_message(call, ctx)

        if "tool_args" in ctx:
            call = {**call, "args": ctx["tool_args"]}

        t0 = time.time()
        result = await super()._arun_one(call, input_type, tool_runtime)
        duration_ms = int((time.time() - t0) * 1000)
        return await _apply_post_hook(result, call, duration_ms)

    def _run_one(
        self,
        call: dict[str, Any],
        input_type: str,
        tool_runtime: Any,
    ) -> Any:
        ctx = _run_harness_sync("pre_tool_call", {
            "tool_name": call.get("name"),
            "tool_args": call.get("args") or {},
            "tool_call_id": call.get("id"),
            "thread_id": get_thread_id(),
            "user_tier": get_user_tier(),
        })

        if ctx.get("_rejected"):
            return _rejected_tool_message(call, ctx)

        if "tool_args" in ctx:
            call = {**call, "args": ctx["tool_args"]}

        t0 = time.time()
        result = super()._run_one(call, input_type, tool_runtime)
        duration_ms = int((time.time() - t0) * 1000)
        return _run_harness_sync_result(result, call, duration_ms)


async def _apply_post_hook(
    result: Any,
    call: dict[str, Any],
    duration_ms: int,
) -> Any:
    if isinstance(result, list):
        return [
            await _apply_post_hook(item, call, duration_ms)
            for item in result
        ]

    content = _get_result_content(result)
    if content is None:
        return result

    post_ctx = await harness.run("post_tool_call", {
        "tool_name": call.get("name"),
        "tool_result": content,
        "duration_ms": duration_ms,
        "tool_call_id": call.get("id"),
        "thread_id": get_thread_id(),
    })
    if "tool_result" in post_ctx:
        return _replace_result_content(result, post_ctx["tool_result"])
    return result


def _run_harness_sync(hook_point: str, context: dict[str, Any]) -> dict[str, Any]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(harness.run(hook_point, context))
    raise RuntimeError("HarnessToolNode sync path cannot run inside an active event loop")


def _run_harness_sync_result(
    result: Any,
    call: dict[str, Any],
    duration_ms: int,
) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_apply_post_hook(result, call, duration_ms))
    raise RuntimeError("HarnessToolNode sync path cannot run inside an active event loop")


def _rejected_tool_message(call: dict[str, Any], context: dict[str, Any]) -> ToolMessage:
    return ToolMessage(
        content=f"[Harness 拒绝] {context.get('_reject_reason', '未知原因')}",
        name=str(call.get("name") or "unknown_tool"),
        tool_call_id=str(call.get("id") or "unknown_tool_call"),
    )


def _get_result_content(result: Any) -> str | None:
    if isinstance(result, dict):
        value = result.get("content")
        return str(value) if value is not None else None
    value = getattr(result, "content", None)
    return str(value) if value is not None else None


def _replace_result_content(result: Any, content: str) -> Any:
    if isinstance(result, dict):
        return {**result, "content": content}
    if hasattr(result, "model_copy"):
        return result.model_copy(update={"content": content})
    if hasattr(result, "copy"):
        return result.copy(update={"content": content})
    if hasattr(result, "content"):
        result.content = content
        return result
    return content
