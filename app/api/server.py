# app/api/server.py
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.agent.main_agent import run_agent as _run_agent_internal
from app.api.context import UserTier
from app.api.monitor import monitor
from app.api.connection import manager
from app.harness.middleware import harness
from app.harness.setup import setup_harness
from app.observability.langfuse_client import create_trace, flush_langfuse
from app.observability.trace_ctx import set_langfuse_trace
from app.utils.path_utils import OUTPUT_ROOT, ensure_session_dir, ensure_upload_dir, safe_join
from app.utils.thread_ctx import thread_scope


TaskState = Literal["queued", "running", "completed", "failed", "cancelling", "cancelled"]


class TaskRequest(BaseModel):
    query: str = Field(..., min_length=1)
    thread_id: str | None = Field(default=None, min_length=1)
    user_id: str | None = None
    user_tier: UserTier = "free"


class TaskAccepted(BaseModel):
    thread_id: str
    status: TaskState
    websocket_url: str
    session_dir: str


class TaskStatus(BaseModel):
    thread_id: str
    status: TaskState
    done: bool
    cancelled: bool = False
    result: dict[str, Any] | None = None
    error: str | None = None


app = FastAPI(title="HeartShop Agent API", version="0.1.0")
setup_harness()

active_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
task_states: dict[str, TaskState] = {}
task_results: dict[str, dict[str, Any]] = {}
task_errors: dict[str, str] = {}
_task_lock = asyncio.Lock()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/task", response_model=TaskAccepted)
async def create_task(request: TaskRequest) -> TaskAccepted:
    thread_id = request.thread_id or uuid.uuid4().hex
    session_dir = ensure_session_dir(thread_id)

    async with _task_lock:
        old_task = active_tasks.get(thread_id)
        if old_task and not old_task.done():
            old_task.cancel()

        task_results.pop(thread_id, None)
        task_errors.pop(thread_id, None)
        task_states[thread_id] = "queued"
        active_tasks[thread_id] = asyncio.create_task(
            _run_task(request.query, thread_id, request.user_id, request.user_tier),
            name=f"heartshop:{thread_id}",
        )

    return TaskAccepted(
        thread_id=thread_id,
        status="queued",
        websocket_url=f"/ws/{thread_id}",
        session_dir=str(session_dir),
    )


@app.get("/api/task/{thread_id}", response_model=TaskStatus)
async def get_task_status(thread_id: str) -> TaskStatus:
    if thread_id not in task_states:
        raise HTTPException(status_code=404, detail="Unknown thread_id")

    task = active_tasks.get(thread_id)
    status = task_states[thread_id]
    done = task.done() if task else status in {"completed", "failed", "cancelled"}
    return TaskStatus(
        thread_id=thread_id,
        status=status,
        done=done,
        cancelled=status == "cancelled",
        result=task_results.get(thread_id),
        error=task_errors.get(thread_id),
    )


@app.post("/api/task/{thread_id}/cancel", response_model=TaskStatus)
async def cancel_task(thread_id: str) -> TaskStatus:
    async with _task_lock:
        task = active_tasks.get(thread_id)
        if thread_id not in task_states:
            raise HTTPException(status_code=404, detail="Unknown thread_id")
        if task and not task.done():
            task_states[thread_id] = "cancelling"
            task.cancel()
        elif task_states[thread_id] not in {"completed", "failed", "cancelled"}:
            task_states[thread_id] = "cancelled"

    return await get_task_status(thread_id)


@app.get("/api/files/{thread_id}/{filename}")
async def download_file(thread_id: str, filename: str) -> FileResponse:
    session_dir = OUTPUT_ROOT / thread_id
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        target = safe_join(session_dir, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    return FileResponse(target, filename=filename)


@app.post("/api/upload")
async def upload_file(thread_id: str, file: UploadFile = File(...)) -> dict[str, str]:
    upload_dir = ensure_upload_dir(thread_id)
    if file.filename is None:
        raise HTTPException(status_code=400, detail="Missing filename")

    try:
        target = safe_join(upload_dir, file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(await file.read())
    return {"status": "ok", "path": str(target.relative_to(upload_dir.parent.parent.resolve()))}


@app.websocket("/ws/{thread_id}")
async def task_events(websocket: WebSocket, thread_id: str) -> None:
    await manager.connect(websocket, thread_id)
    try:
        await websocket.send_json(_monitor_payload(
            event="session_created",
            message="会话已创建",
            data={
                "thread_id": thread_id,
                "session_dir": str(ensure_session_dir(thread_id)),
            },
        ))
        while True:
            await websocket.receive_text()
            await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket, thread_id)


async def _run_task(
    query: str,
    thread_id: str,
    user_id: str | None,
    user_tier: UserTier,
) -> dict[str, Any]:
    session_dir = ensure_session_dir(thread_id)
    current_task = asyncio.current_task()

    with thread_scope(thread_id, session_dir, user_tier):
        if _is_current_task(thread_id, current_task):
            task_states[thread_id] = "running"
        try:
            result = await run_agent(query, thread_id, user_id, user_tier)
            if _is_current_task(thread_id, current_task):
                final_answer = _extract_final_answer(result)
                await monitor.report_task_result(final_answer)
                task_results[thread_id] = result
                task_states[thread_id] = "completed"
            return result
        except asyncio.CancelledError:
            if _is_current_task(thread_id, current_task):
                task_states[thread_id] = "cancelled"
                await monitor.report_task_cancelled()
            raise
        except Exception as exc:
            if _is_current_task(thread_id, current_task):
                task_errors[thread_id] = str(exc)
                task_states[thread_id] = "failed"
                await monitor.report_error(type(exc).__name__, str(exc))
            raise
        finally:
            async with _task_lock:
                if _is_current_task(thread_id, current_task):
                    active_tasks.pop(thread_id, None)


async def run_agent(
    query: str,
    thread_id: str,
    user_id: str | None = None,
    user_tier: UserTier = "free",
) -> dict[str, Any]:
    session_dir = ensure_session_dir(thread_id)
    with thread_scope(thread_id, session_dir, user_tier):
        start_ctx = await harness.run("on_session_start", {
            "query": query,
            "thread_id": thread_id,
            "user_id": user_id,
            "user_tier": user_tier,
            "session_dir": str(session_dir),
        })
        query = str(start_ctx.get("query", query))

        trace = create_trace(
            name="heartshop-agent",
            thread_id=thread_id,
            user_id=user_id,
            input={"query": query},
            metadata={
                "model": os.environ.get("DEEPSEEK_MODEL_MAIN", ""),
                "user_tier": user_tier,
            },
        )
        set_langfuse_trace(trace)

        try:
            result = await _run_agent_internal(query, thread_id, user_id, user_tier)
            final_answer = _extract_final_answer(result)
            end_ctx = await harness.run("on_session_end", {
                "final_answer": final_answer,
                "thread_id": thread_id,
                "user_id": user_id,
                "user_tier": user_tier,
                "session_dir": str(session_dir),
                "trajectory": result.get("messages", []),
                "learned_preferences": result.get("learned_preferences", []),
            })
            final_answer = str(end_ctx.get("final_answer", final_answer))
            if result.get("final") != final_answer:
                result = {**result, "final": final_answer}
            trace.update(output={"final_answer": final_answer})
            return result
        except Exception as exc:
            trace.update(output={"error": str(exc)}, level="ERROR")
            raise
        finally:
            try:
                if hasattr(trace, "end"):
                    trace.end()
                flush_langfuse()
            finally:
                set_langfuse_trace(None)


def _extract_final_answer(result: dict[str, Any]) -> str:
    final = result.get("final") or result.get("final_text")
    if isinstance(final, str):
        return final
    return str(result)


def _is_current_task(thread_id: str, task: asyncio.Task[Any] | None) -> bool:
    return task is not None and active_tasks.get(thread_id) is task


def _monitor_payload(event: str, message: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "monitor_event",
        "event": event,
        "message": message,
        "data": data,
        "timestamp": datetime.now().isoformat(),
    }
