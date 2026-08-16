"""SSE 任务事件流（P4-W03、OBS-003）。"""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from ..dependencies import get_anonymous_user_id, get_command_service

router = APIRouter(tags=["events"])

POLL_INTERVAL = 0.5  # 秒；规格 ≤ 500ms
HEARTBEAT_INTERVAL = 15.0  # 秒


@router.get("/{mission_id}/events")
async def stream_events(
    mission_id: str,
    request: Request,
    after: int = Query(default=0, ge=0),
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
):
    """从 PostgreSQL 增量读取事件并推送；支持 after 恢复（OBS-003）。

    断线不取消已接受的运行；重连携带 after 可看到后续事件。
    """

    async def event_stream():
        last_seq = after
        last_beat = time.monotonic()
        while True:
            # 断线检测：uvicorn 在连接关闭时通过 receive 返回 http.disconnect
            try:
                message = await asyncio.wait_for(request.receive(), timeout=0.2)
            except (TimeoutError, asyncio.CancelledError):
                message = {}
            if message.get("type") == "http.disconnect":
                break

            events = await svc.list_events(owner_id=owner_id, mission_id=mission_id, after=last_seq)
            for event in events:
                last_seq = event["sequence"]
                data = json.dumps(event["payload"], ensure_ascii=False)
                yield f"id: {event['sequence']}\nevent: {event['event_type']}\ndata: {data}\n\n"
            if time.monotonic() - last_beat >= HEARTBEAT_INTERVAL:
                yield ": heartbeat\n\n"
                last_beat = time.monotonic()
            await asyncio.sleep(POLL_INTERVAL)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
