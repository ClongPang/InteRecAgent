"""数据库迁移测试（P2-W01 门禁，integration marker，需要 PostgreSQL 运行中）。

- 迁移往返：downgrade base → upgrade head 成功；
- 七张核心表 + 唯一约束/索引存在；
- ORM metadata 与迁移无漂移（alembic check）。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import create_async_engine

ROOT = Path(__file__).resolve().parents[1]
TEST_DB_URL = os.environ.get(
    "INTEREC_TEST_DATABASE_URL",
    "postgresql+asyncpg://interec:interec@localhost:5432/interec_test",
)

pytestmark = pytest.mark.integration

EXPECTED_TABLES = {
    "shopping_missions",
    "mission_events",
    "product_snapshots",
    "fx_snapshots",
    "candidate_sets",
    "recommendation_runs",
    "idempotency_records",
}


def _alembic(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, INTEREC_DATABASE_URL=TEST_DB_URL)
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


def test_migration_roundtrip() -> None:
    """空库升级、降级、再次升级均成功（BE-006/ASM-003）。"""
    down = _alembic("downgrade", "base")
    assert down.returncode == 0, down.stderr
    up = _alembic("upgrade", "head")
    assert up.returncode == 0, up.stderr


def test_alembic_check_no_drift() -> None:
    """ORM metadata 与迁移无漂移（P2-W01 门禁）。"""
    result = _alembic("check")
    assert result.returncode == 0, result.stderr


def _collect_schema(sync_conn) -> dict:
    """在 run_sync 的 greenlet 上下文中完成全部 schema 反射。"""
    inspector = sa_inspect(sync_conn)
    return {
        "tables": set(inspector.get_table_names()),
        "idempotency_uq": [c["name"] for c in inspector.get_unique_constraints("idempotency_records")],
        "mission_idx": {i["name"] for i in inspector.get_indexes("shopping_missions")},
        "event_uq": [c["name"] for c in inspector.get_unique_constraints("mission_events")],
    }


@pytest.mark.asyncio
async def test_seven_tables_and_constraints_exist() -> None:
    """DAT-001/DAT-005：七表齐全，幂等唯一约束与索引存在。"""
    engine = create_async_engine(TEST_DB_URL)
    try:
        async with engine.connect() as conn:
            schema = await conn.run_sync(_collect_schema)
        assert EXPECTED_TABLES <= schema["tables"], f"缺少表: {EXPECTED_TABLES - schema['tables']}"
        assert "uq_idempotency_owner_key" in schema["idempotency_uq"]
        assert "ix_shopping_missions_owner_updated_id" in schema["mission_idx"]
        assert "uq_mission_events_mission_sequence" in schema["event_uq"]
    finally:
        await engine.dispose()
