# app/observability/langfuse_handler.py
from typing import Any

from app.observability.trace_ctx import get_langfuse_trace


def create_langfuse_handler(thread_id: str) -> Any | None:
    """为当前请求创建 LangFuse callback handler.

    接入方式：传给 LangGraph 的 config["callbacks"]。
    """
    trace = get_langfuse_trace()
    trace_id = getattr(trace, "trace_id", None)
    if not trace_id:
        return None

    from langfuse.langchain import CallbackHandler as LangfuseCallbackHandler

    return LangfuseCallbackHandler(
        trace_context={"trace_id": trace_id},
        # LangFuse SDK 会自动记录每次 LLM 调用的 token / 延迟
    )
