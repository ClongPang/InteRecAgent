# app/observability/trace_ctx.py
from contextvars import ContextVar
from typing import Any


_langfuse_trace_var: ContextVar[Any | None] = ContextVar(
    "heartShop_langfuse_trace", default=None
)
_current_span_var: ContextVar[Any | None] = ContextVar(
    "heartShop_langfuse_current_span", default=None
)


def set_langfuse_trace(trace: Any | None) -> None:
    _langfuse_trace_var.set(trace)


def get_langfuse_trace() -> Any | None:
    return _langfuse_trace_var.get()


def set_current_span(span: Any | None) -> None:
    _current_span_var.set(span)


def get_current_span() -> Any | None:
    return _current_span_var.get()
