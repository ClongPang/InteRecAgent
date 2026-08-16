"""trace_id 中间件（OBS-001）。纯 ASGI 实现，不干扰 StreamingResponse 流式传输。"""
from __future__ import annotations

import uuid

from starlette.datastructures import MutableHeaders


class TraceMiddleware:
    """为每个请求生成或透传 trace_id，并回写响应头。"""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        trace_id = headers.get(b"x-trace-id") or str(uuid.uuid4()).encode()
        trace_id_str = trace_id.decode("ascii", "ignore") or str(uuid.uuid4())
        scope.setdefault("state", {})["trace_id"] = trace_id_str

        async def send_wrapper(message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                mutable = MutableHeaders(scope=message)
                mutable["X-Trace-ID"] = trace_id_str
            await send(message)

        await self.app(scope, receive, send_wrapper)
