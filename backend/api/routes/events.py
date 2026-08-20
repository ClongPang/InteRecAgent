"""SSE 任务事件流与本轮 token 流"""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from ...application.dto import SSE_PUBLIC_EVENTS
from ..dependencies import get_anonymous_user_id, get_command_service
from ..sse import SSE_HEADERS, format_sse, resume_after, wait_or_disconnect

router = APIRouter(tags=["events"])

HEARTBEAT_INTERVAL = 15.0


@router.get("/{mission_id}/events")
async def stream_events(
    mission_id: str,
    request: Request,
    after: int | None = Query(default=None, ge=0),
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
):
    """
    任务级 durable 事件。写入提交后敲门铃，本连接醒来再 ``list_since``。
    断线不取消已接受的运行；重连带 ``after`` 或 ``Last-Event-ID``。
    """
    await svc.get_mission(owner_id=owner_id, mission_id=mission_id)
    last_seq = resume_after(after=after, request=request)

    async def event_stream():
        nonlocal last_seq
        last_beat = time.monotonic()
        try:
            while True:
                events = await svc.list_events(
                    owner_id=owner_id, mission_id=mission_id, after=last_seq
                )
                if events:
                    for event in events:
                        last_seq = event["sequence"]
                        if event["event_type"] not in SSE_PUBLIC_EVENTS:
                            continue
                        yield format_sse(
                            id=event["sequence"],
                            event=event["event_type"],
                            data=event["payload"],
                        )
                    last_beat = time.monotonic()
                    continue
                if time.monotonic() - last_beat >= HEARTBEAT_INTERVAL:
                    yield ": heartbeat\n\n"
                    last_beat = time.monotonic()
                remaining = max(0.2, HEARTBEAT_INTERVAL - (time.monotonic() - last_beat))
                outcome = await wait_or_disconnect(
                    request,
                    svc.wait_for_events(
                        owner_id=owner_id,
                        mission_id=mission_id,
                        after=last_seq,
                        timeout=remaining,
                    ),
                )
                if outcome == "disconnect":
                    return
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.get("/{mission_id}/runs/{run_id}/text")
async def stream_run_text(
    mission_id: str,
    run_id: str,
    request: Request,
    after: int = Query(default=0, ge=0),
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
):
    """本轮 ephemeral token。结束后关连接；错过则回放 ``agent.message``。"""
    await svc.get_mission(owner_id=owner_id, mission_id=mission_id)
    hub = svc.text_hub

    async def text_stream():
        index = after
        try:
            while True:
                snap = hub.snapshot(run_id) if hub is not None else None
                if snap is None:
                    replayed = await svc.replay_run_text(
                        owner_id=owner_id, mission_id=mission_id, run_id=run_id
                    )
                    if replayed is None:
                        mission = await svc.get_mission(
                            owner_id=owner_id, mission_id=mission_id
                        )
                        if (
                            mission.turn_phase.value == "idle"
                            and mission.active_run_id != run_id
                        ):
                            yield format_sse(
                                id=1,
                                event="agent.message.aborted",
                                data={"run_id": run_id, "text": ""},
                            )
                            return
                    if replayed is not None:
                        yield format_sse(
                            id=1,
                            event="agent.message.delta",
                            data={"run_id": run_id, "delta": replayed},
                        )
                        yield format_sse(
                            id=2,
                            event="agent.message.completed",
                            data={"run_id": run_id, "text": replayed},
                        )
                        return
                    outcome = await wait_or_disconnect(
                        request,
                        hub.wait(run_id, after=index, timeout=1.0)
                        if hub is not None
                        else asyncio.sleep(1.0),
                    )
                    if outcome == "disconnect":
                        return
                    continue
                while index < len(snap["deltas"]):
                    index += 1
                    yield format_sse(
                        id=index,
                        event="agent.message.delta",
                        data={"run_id": run_id, "delta": snap["deltas"][index - 1]},
                    )
                if snap["done"]:
                    yield format_sse(
                        id=index + 1,
                        event="agent.message.completed"
                        if not snap["aborted"]
                        else "agent.message.aborted",
                        data={"run_id": run_id, "text": snap["text"]},
                    )
                    return
                outcome = await wait_or_disconnect(
                    request,
                    hub.wait(run_id, after=index, timeout=HEARTBEAT_INTERVAL),
                )
                if outcome == "disconnect":
                    return
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        text_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
