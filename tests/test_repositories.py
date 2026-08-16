"""Repository 与事务测试（P2-W02 门禁，integration marker，需要 PostgreSQL）。

验证：事件与版本原子性、版本冲突、回滚不留半条记录、sequence 单调递增。
"""
from __future__ import annotations

import os

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.application.dto import ShoppingMission
from backend.application.errors import MissionVersionConflict
from backend.infrastructure.persistence.orm import MissionEventRow, ShoppingMissionRow
from backend.infrastructure.persistence.unit_of_work import SqlAlchemyUnitOfWork

TEST_DB_URL = os.environ.get(
    "INTEREC_TEST_DATABASE_URL",
    "postgresql+asyncpg://interec:interec@localhost:5432/interec_test",
)

pytestmark = pytest.mark.integration

OWNER_U1 = "11111111-1111-1111-1111-111111111111"
OWNER_U2 = "22222222-2222-2222-2222-222222222222"

TRUNCATE_SQL = (
    "TRUNCATE TABLE mission_events, candidate_sets, recommendation_runs, "
    "product_snapshots, fx_snapshots, idempotency_records, shopping_missions "
    "RESTART IDENTITY CASCADE"
)


@pytest.fixture
async def uow_factory():
    engine = create_async_engine(TEST_DB_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.exec_driver_sql(TRUNCATE_SQL)
    yield session_factory
    await engine.dispose()


async def _count(session, model) -> int:
    return await session.scalar(select(func.count()).select_from(model))


@pytest.mark.asyncio
async def test_create_mission_and_first_event_commit_atomically(uow_factory) -> None:
    """DAT-005：创建任务 + 首事件在同一个事务提交。"""
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        mission = await uow.missions.create(owner_id=OWNER_U1, title="通勤降噪耳机")
        await uow.events.append(mission_id=mission.id, event_type="mission.created", payload={})
        await uow.commit()

    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        loaded = await uow.missions.get(owner_id=OWNER_U1, mission_id=mission.id)
        assert loaded is not None and loaded.title == "通勤降噪耳机"
        assert loaded.constraints_version == 1
        events = await uow.events.list_since(mission_id=mission.id)
        assert [e["event_type"] for e in events] == ["mission.created"]


@pytest.mark.asyncio
async def test_rollback_leaves_no_partial_records(uow_factory) -> None:
    """回滚不留下半条记录（任务与事件都不可见）。"""
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        mission = await uow.missions.create(owner_id=OWNER_U1, title="会被回滚")
        await uow.events.append(mission_id=mission.id, event_type="mission.created", payload={})
        await uow.rollback()

    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        assert await uow.missions.get(owner_id=OWNER_U1, mission_id=mission.id) is None
        assert await _count(uow._session, ShoppingMissionRow) == 0
        assert await _count(uow._session, MissionEventRow) == 0


@pytest.mark.asyncio
async def test_version_conflict_on_stale_save(uow_factory) -> None:
    """AGT-005：旧版本运行写入新版本任务被拒绝。"""
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        mission = await uow.missions.create(owner_id=OWNER_U1, title="并发任务")
        await uow.commit()
        mission_id = mission.id

    # 模拟其他请求已把版本推进到 2
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        current = await uow.missions.get(owner_id=OWNER_U1, mission_id=mission_id)
        assert current is not None
        current.constraints_version = 2
        await uow.missions.save(current, expected_version=1)
        await uow.commit()

    # 持有旧版本（v1）的调用方写回 → 冲突
    stale = ShoppingMission(id=mission_id, owner_id=OWNER_U1, title="并发任务", constraints_version=1)
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        with pytest.raises(MissionVersionConflict):
            await uow.missions.save(stale, expected_version=1)


@pytest.mark.asyncio
async def test_event_sequence_is_monotonic(uow_factory) -> None:
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        mission = await uow.missions.create(owner_id=OWNER_U1, title="seq")
        s1 = await uow.events.append(mission_id=mission.id, event_type="a", payload={})
        s2 = await uow.events.append(mission_id=mission.id, event_type="b", payload={})
        s3 = await uow.events.append(mission_id=mission.id, event_type="c", payload={})
        await uow.commit()
    assert [s1, s2, s3] == [1, 2, 3]


@pytest.mark.asyncio
async def test_repository_cross_owner_isolation(uow_factory) -> None:
    """跨 owner 读取返回 None（不泄漏资源存在性）。"""
    async with SqlAlchemyUnitOfWork(uow_factory) as uow:
        mission = await uow.missions.create(owner_id=OWNER_U1, title="私有任务")
        await uow.commit()
        assert await uow.missions.get(owner_id=OWNER_U2, mission_id=mission.id) is None
