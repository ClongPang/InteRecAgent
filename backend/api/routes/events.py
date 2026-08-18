"""SSE 任务事件流"""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from ...application.dto import SSE_PUBLIC_EVENTS
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
    """
    从 PostgreSQL 增量读取事件并推送；支持 after 恢复
    断线不取消已接受的运行；重连携带 after 可看到后续事件。
    给某个任务开一条长期连接，把 Agent 运行过程中写入数据库的事件，按序号推给前端

    为什么需要它
    missions 里那些写接口（创建任务、发消息、改约束、undo）大多返回 202 + run_id，意思是“请求已接受，后台还在跑”。
    它们不会等推荐算完再返回。前端要知道现在到哪一步（收到消息、在澄清、推荐好了、降级了），不能靠反复 GET /missions/{id} 死磕。
    这条 SSE就是任务的实时进度通道。

    怎么工作
    1. 客户端连上后，服务端返回 text/event-stream，连接一直挂着。
    2. 循环里大约每 500ms 查一次库：list_events(..., after=last_seq)，只取序号大于 after 的新事件。
    3. 每条事件按 SSE 格式写出：
    id: 3
    event: recommendation.ready
    data: {...payload...}
    4. 超过 15 秒没有新业务事件，就发 : heartbeat，防止代理把空闲连接掐掉。
    5. 客户端断开时检测到 http.disconnect 就退出循环。断线不会取消已经接受的运行；重连时带上上次的
        after（事件序号），从断点继续收。

    after 默认是 0，表示从头播；重连时传上次看到的最大 id。`

    """
    await svc.get_mission(owner_id=owner_id, mission_id=mission_id)

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
                if event["event_type"] not in SSE_PUBLIC_EVENTS:
                    continue
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
