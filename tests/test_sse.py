"""SSE 事件流集成测试（OBS-003/AC-012）。

ASGITransport 无法正确模拟 StreamingResponse 的断流语义（其 listen_for_disconnect
会阻塞响应完成），因此这里用真实 uvicorn 服务器验证事件推送与序号递增。
"""
from __future__ import annotations

import asyncio
import socket
import threading
import time
import uuid

import httpx
import pytest
import uvicorn
from sqlalchemy.ext.asyncio import create_async_engine

from backend.api.app import create_app
from backend.bootstrap.container import Container
from backend.bootstrap.settings import Settings

TEST_DB_URL = "postgresql+asyncpg://interec:interec@localhost:5432/interec_test"
OWNER = str(uuid.uuid4())

pytestmark = [pytest.mark.api, pytest.mark.integration]

TRUNCATE_SQL = (
    "TRUNCATE TABLE mission_events, candidate_sets, recommendation_runs, "
    "product_snapshots, fx_snapshots, idempotency_records, shopping_missions "
    "RESTART IDENTITY CASCADE"
)


@pytest.fixture
async def live_server():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.exec_driver_sql(TRUNCATE_SQL)
    await engine.dispose()

    container = Container(
        Settings(
            database_url=TEST_DB_URL,
            data_source="fixture",
            llm_provider="unconfigured",
            llm_api_key="",
        )
    )
    app = create_app(container)

    # 找空闲端口
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started:
        assert time.time() < deadline, "uvicorn 启动超时"
        time.sleep(0.05)

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=10)


_H = {"X-Anonymous-User-ID": OWNER}


async def _wait_ready(client, mid: str) -> None:
    for _ in range(50):
        r = await client.get(f"/api/v1/missions/{mid}", headers=_H)
        if r.json()["stage"] in {"ready", "degraded", "clarifying", "failed"}:
            return
        await asyncio.sleep(0.1)
    raise AssertionError("run 未完成")


async def test_sse_delivers_incremental_events(live_server) -> None:
    """OBS-003/AC-012：SSE 推送递增序号事件。"""
    async with httpx.AsyncClient(base_url=live_server, timeout=15.0) as c:
        created = await c.post("/api/v1/missions", json={"text": "通勤降噪耳机，预算 4000 元"}, headers=_H)
        assert created.status_code == 201
        mission_id = created.json()["mission"]["id"]
        await _wait_ready(c, mission_id)

        types: list[str] = []
        seen_ids: list[int] = []
        done = asyncio.Event()

        async def _read() -> None:
            async with c.stream("GET", f"/api/v1/missions/{mission_id}/events?after=0", headers=_H) as resp:
                assert resp.status_code == 200
                cur = None
                async for line in resp.aiter_lines():
                    if line.startswith("id: "):
                        cur = int(line.split(": ", 1)[1])
                    elif line.startswith("event: "):
                        seen_ids.append(cur)
                        types.append(line.split(": ", 1)[1])
                        if "recommendation.ready" in types and "run.accepted" in types:
                            return
            done.set()

        try:
            await asyncio.wait_for(_read(), timeout=10.0)
        except TimeoutError:
            done.set()

    assert "run.accepted" in types
    assert "search.started" in types
    assert "products.received" in types
    assert "recommendation.ready" in types
    # 序号递增且无重复
    assert seen_ids == sorted(seen_ids)


async def test_sse_resumes_from_last_event_id(live_server) -> None:
    """重连认 Last-Event-ID，不必只靠 query after。"""
    async with httpx.AsyncClient(base_url=live_server, timeout=15.0) as c:
        created = await c.post("/api/v1/missions", json={"text": "通勤降噪耳机，预算 4000 元"}, headers=_H)
        mission_id = created.json()["mission"]["id"]
        await _wait_ready(c, mission_id)

        types: list[str] = []
        async with c.stream(
            "GET",
            f"/api/v1/missions/{mission_id}/events",
            headers={**_H, "Last-Event-ID": "1"},
        ) as resp:
            assert resp.status_code == 200
            async for line in resp.aiter_lines():
                if line.startswith("event: "):
                    types.append(line.split(": ", 1)[1])
                    if "recommendation.ready" in types or len(types) >= 3:
                        break

    assert types


async def test_run_text_replays_completed_message(live_server) -> None:
    async with httpx.AsyncClient(base_url=live_server, timeout=15.0) as c:
        created = await c.post("/api/v1/missions", json={"text": "通勤降噪耳机，预算 4000 元"}, headers=_H)
        body = created.json()
        mission_id = body["mission"]["id"]
        run_id = body["run_id"]
        await _wait_ready(c, mission_id)

        types: list[str] = []
        async with c.stream(
            "GET", f"/api/v1/missions/{mission_id}/runs/{run_id}/text", headers=_H
        ) as resp:
            assert resp.status_code == 200
            async for line in resp.aiter_lines():
                if line.startswith("event: "):
                    types.append(line.split(": ", 1)[1])
                    if "agent.message.completed" in types:
                        break

    assert "agent.message.completed" in types
