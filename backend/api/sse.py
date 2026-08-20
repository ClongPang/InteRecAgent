"""SSE 帧格式与断线等待。事件表是真相；这里只负责 HTTP 帧。"""
from __future__ import annotations

import asyncio
import json

from fastapi import Request


def format_sse(*, event: str, data: dict | str, id: int | str | None = None) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    lines: list[str] = []
    if id is not None:
        lines.append(f"id: {id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {payload}")
    return "\n".join(lines) + "\n\n"


def resume_after(*, after: int | None, request: Request) -> int:
    if after is not None:
        return after
    header = request.headers.get("last-event-id")
    if header and header.isdigit():
        return int(header)
    return 0


async def until_disconnect(request: Request) -> None:
    while True:
        message = await request.receive()
        if message.get("type") == "http.disconnect":
            return


async def wait_or_disconnect(request: Request, waiter) -> str:
    """返回 ``wake`` 或 ``disconnect``。取消未完成的一侧，避免泄漏。"""
    wait_task = asyncio.create_task(waiter)
    disc_task = asyncio.create_task(until_disconnect(request))
    done, pending = await asyncio.wait(
        {wait_task, disc_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    if wait_task in done:
        exc = wait_task.exception()
        if isinstance(exc, asyncio.CancelledError):
            return "disconnect"
        if exc is not None:
            raise exc
    if disc_task in done:
        return "disconnect"
    return "wake"


SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}
