"""FastAPI BFF 测试（P4-W01/P4-W02 门禁，integration marker）。

覆盖：健康检查、trace_id、错误契约、任务创建/运行、分页、跨 owner 404、
比较 2–4 边界、版本冲突、undo。
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from backend.api.app import create_app
from backend.bootstrap.container import Container
from backend.bootstrap.settings import Settings

TEST_DB_URL = "postgresql+asyncpg://interec:interec@localhost:5432/interec_test"
OWNER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
OWNER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

pytestmark = [pytest.mark.api, pytest.mark.integration]

TRUNCATE_SQL = (
    "TRUNCATE TABLE mission_events, candidate_sets, recommendation_runs, "
    "product_snapshots, fx_snapshots, idempotency_records, shopping_missions "
    "RESTART IDENTITY CASCADE"
)


@pytest.fixture
async def client():
    engine = create_async_engine(TEST_DB_URL, poolclass=NullPool)
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
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


def _headers(owner: str = OWNER_A) -> dict:
    return {"X-Anonymous-User-ID": owner}


async def _create_mission(client, text: str, owner: str = OWNER_A) -> dict:
    resp = await client.post("/api/v1/missions", json={"text": text}, headers=_headers(owner))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _wait_terminal(client, mission_id: str, owner: str = OWNER_A, timeout: float = 10.0) -> dict:
    """后台运行完成前轮询任务投影到终态（ready/degraded/clarifying/failed）。"""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        resp = await client.get(f"/api/v1/missions/{mission_id}", headers=_headers(owner))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        if body["stage"] in {"ready", "degraded", "clarifying", "failed"}:
            return body
        assert asyncio.get_running_loop().time() < deadline, f"等待运行完成超时: {body['stage']}"
        await asyncio.sleep(0.1)


# ── P4-W01：API Shell ───────────────────────────────────────

async def test_health_live_and_ready(client) -> None:
    live = await client.get("/api/v1/health/live")
    assert live.status_code == 200
    assert live.json() == {"status": "ok"}
    ready = await client.get("/api/v1/health/ready")
    assert ready.status_code == 200


async def test_trace_id_header_present(client) -> None:
    resp = await client.get("/api/v1/health/live")
    assert "X-Trace-ID" in resp.headers
    assert resp.headers["X-Trace-ID"]


async def test_error_contract_and_trace_id(client) -> None:
    resp = await client.get("/api/v1/missions/00000000-0000-0000-0000-00000000dead", headers=_headers())
    assert resp.status_code == 404
    body = resp.json()["error"]
    assert body["code"] == "mission_not_found"
    assert body["category"] == "user"
    assert body["retryable"] is False
    assert body["trace_id"]  # 关联请求


async def test_invalid_user_id_header_rejected(client) -> None:
    resp = await client.get("/api/v1/missions", headers={"X-Anonymous-User-ID": "not-a-uuid"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_anonymous_user"


# ── P4-W02：Mission Commands ────────────────────────────────

async def test_create_mission_runs_agent_to_ready(client) -> None:
    """AC-001：创建任务 → Agent 后台运行 → 候选可用。"""
    data = await _create_mission(client, "通勤降噪耳机，预算 4000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    assert data["run_id"]
    assert mission["stage"] == "ready"
    assert mission["candidate_set_id"]

    cands = await client.get(f"/api/v1/missions/{mission['id']}/candidates", headers=_headers())
    assert cands.status_code == 200
    ranked = cands.json()["ranked"]
    assert ranked
    assert ranked[0]["snapshot_id"]
    assert "source_product_id" not in ranked[0]
    assert "owner_id" not in mission


async def test_mission_list_pagination_stable(client) -> None:
    for i in range(3):
        await _create_mission(client, f"通勤降噪耳机 {i}")
    page1 = await client.get("/api/v1/missions?limit=2&offset=0", headers=_headers())
    page2 = await client.get("/api/v1/missions?limit=2&offset=2", headers=_headers())
    ids1 = [m["id"] for m in page1.json()["missions"]]
    ids2 = [m["id"] for m in page2.json()["missions"]]
    assert len(ids1) == 2 and len(ids2) == 1
    assert not set(ids1) & set(ids2)
    # 稳定排序：第二次请求结果一致
    again = await client.get("/api/v1/missions?limit=2&offset=0", headers=_headers())
    assert [m["id"] for m in again.json()["missions"]] == ids1


async def test_cross_owner_isolation_returns_404(client) -> None:
    data = await _create_mission(client, "通勤降噪耳机")
    resp = await client.get(
        f"/api/v1/missions/{data['mission']['id']}", headers=_headers(OWNER_B)
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "mission_not_found"


async def test_comparison_two_to_four_boundary(client) -> None:
    data = await _create_mission(client, "通勤降噪耳机，预算 4000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    mission_id = mission["id"]
    version = mission["constraints_version"]
    cands = (await client.get(f"/api/v1/missions/{mission_id}/candidates", headers=_headers())).json()
    ids = [p["snapshot_id"] for p in cands["ranked"]]

    # 1 件 → 校验错误（schema 422 或路由 400）
    bad = await client.put(
        f"/api/v1/missions/{mission_id}/comparison",
        json={"constraints_version": version, "snapshot_ids": ids[:1]},
        headers=_headers(),
    )
    assert bad.status_code in (400, 422)

    # 2 件 → 200
    ok2 = await client.put(
        f"/api/v1/missions/{mission_id}/comparison",
        json={"constraints_version": version, "snapshot_ids": ids[:2]},
        headers=_headers(),
    )
    assert ok2.status_code == 200
    assert len(ok2.json()["comparison_snapshot_ids"]) == 2

    # 5 件 → 校验错误
    bad5 = await client.put(
        f"/api/v1/missions/{mission_id}/comparison",
        json={"constraints_version": version, "snapshot_ids": (ids * 3)[:5]},
        headers=_headers(),
    )
    assert bad5.status_code in (400, 422)


async def test_version_conflict_returns_409(client) -> None:
    data = await _create_mission(client, "通勤降噪耳机，预算 4000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    mission_id = mission["id"]
    assert mission["constraints_version"] > 1

    # 用旧版本 1 修改约束 → 409
    resp = await client.patch(
        f"/api/v1/missions/{mission_id}/constraints",
        json={"constraints_version": 1, "budget_cny": 3000},
        headers=_headers(),
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "mission_version_conflict"


async def test_undo_restores_constraints(client) -> None:
    data = await _create_mission(client, "通勤降噪耳机，预算 4000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    mission_id = mission["id"]
    version = mission["constraints_version"]

    # 修改预算为 3000
    patch = await client.patch(
        f"/api/v1/missions/{mission_id}/constraints",
        json={"constraints_version": version, "budget_cny": 3000},
        headers=_headers(),
    )
    assert patch.status_code == 202
    new_version = patch.json()["constraints_version"]

    after_patch = await client.get(f"/api/v1/missions/{mission_id}", headers=_headers())
    assert after_patch.json()["constraints"]["budget_cny"] == 3000
    patched = await _wait_terminal(client, mission_id)
    assert patched["stage"] in {"ready", "degraded"}
    assert patched["constraints"]["budget_cny"] == 3000
    assert patched["candidate_set_id"]
    assert patched["constraints_version"] == new_version

    # 撤销 → 恢复到 4000，版本继续单调递增
    undo = await client.post(
        f"/api/v1/missions/{mission_id}/turns",
        json={"command": "undo", "constraints_version": new_version},
        headers=_headers(),
    )
    assert undo.status_code == 202
    assert undo.json()["constraints_version"] > new_version

    after_undo = await client.get(f"/api/v1/missions/{mission_id}", headers=_headers())
    assert after_undo.json()["constraints"]["budget_cny"] == 4000
    restored = await _wait_terminal(client, mission_id)
    assert restored["stage"] in {"ready", "degraded"}
    assert restored["constraints"]["budget_cny"] == 4000
    assert restored["candidate_set_id"]


async def test_undo_without_constraint_change_returns_409(client) -> None:
    data = await _create_mission(client, "通勤降噪耳机，预算 4000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    resp = await client.post(
        f"/api/v1/missions/{mission['id']}/turns",
        json={"command": "undo", "constraints_version": mission["constraints_version"]},
        headers=_headers(),
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "nothing_to_undo"


async def test_recommendation_missing_uses_error_contract(client) -> None:
    data = await _create_mission(client, "预算 2000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    assert mission["stage"] == "clarifying"
    resp = await client.get(
        f"/api/v1/missions/{mission['id']}/recommendation", headers=_headers()
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "recommendation_not_found"


async def test_validation_error_uses_error_contract(client) -> None:
    resp = await client.post("/api/v1/missions", json={"text": ""}, headers=_headers())
    assert resp.status_code == 422
    body = resp.json()["error"]
    assert body["code"] == "validation_error"
    assert body["category"] == "user"
    assert body["details"]["errors"]


async def test_product_snapshot_and_recommendation_use_snapshot_ids(client) -> None:
    data = await _create_mission(client, "通勤降噪耳机，预算 4000 元")
    mission = await _wait_terminal(client, data["mission"]["id"])
    ranked = (await client.get(f"/api/v1/missions/{mission['id']}/candidates", headers=_headers())).json()[
        "ranked"
    ]
    snap_id = ranked[0]["snapshot_id"]
    snap = await client.get(f"/api/v1/product-snapshots/{snap_id}", headers=_headers())
    assert snap.status_code == 200
    assert snap.json()["snapshot_id"] == snap_id
    rec = await client.get(f"/api/v1/missions/{mission['id']}/recommendation", headers=_headers())
    assert rec.status_code == 200
    body = rec.json()
    assert body["primary"]["snapshot_id"] == snap_id
    missing = await client.get(
        "/api/v1/product-snapshots/00000000-0000-0000-0000-00000000dead", headers=_headers()
    )
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "snapshot_not_found"
