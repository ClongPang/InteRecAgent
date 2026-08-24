"""RunDispatcher 生命周期测试（P4-W03、AC-016/BE-009）。

- 启动恢复：遗留 accepted/running → interrupted（可重试）；
- 优雅关闭：grace 内 drain，未完成运行取消并标记 interrupted。
"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.application.dto import RunnerResult, RunnerStatus
from backend.application.errors import DispatcherNotAccepting
from backend.infrastructure.persistence.orm import ShoppingMissionRow
from backend.infrastructure.persistence.unit_of_work import SqlAlchemyUnitOfWork
from backend.infrastructure.runtime.in_process_dispatcher import InProcessRunDispatcher

TEST_DB_URL = "postgresql+asyncpg://interec:interec@localhost:5432/interec_test"
OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
MISSION = "00000000-0000-0000-0000-00000000000a"
RUN = "00000000-0000-0000-0000-00000000000b"

pytestmark = [pytest.mark.api, pytest.mark.integration]

TRUNCATE_SQL = (
    "TRUNCATE TABLE recommendation_runs, mission_events, shopping_missions "
    "RESTART IDENTITY CASCADE"
)


@pytest.fixture
async def db():
    engine = create_async_engine(TEST_DB_URL)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.exec_driver_sql(TRUNCATE_SQL)
    yield sf
    await engine.dispose()


class SlowRunner:
    def __init__(self, delay: float = 0.5) -> None:
        self.delay = delay
        self.runs = 0

    async def run(self, **kwargs):
        self.runs += 1
        await asyncio.sleep(self.delay)


class RolloutRunner:
    async def run(self, **kwargs):
        return RunnerResult(
            status=RunnerStatus.COMPLETED,
            metadata={
                "feature_flags": {
                    "execution_path": "explicit_v2",
                    "release_state": "full",
                }
            },
        )


class FailingRolloutRunner:
    def release_metadata(self, mission_id: str) -> dict:
        del mission_id
        return {
            "feature_flags": {
                "execution_path": "explicit_v2",
                "release_state": "full",
                "qualification_profile_version": "ontology-rules-v10",
            }
        }

    async def run(self, **kwargs):
        del kwargs
        raise RuntimeError("controlled runner failure")


async def _insert_mission(sf) -> None:
    """插入调度所需的外键 mission（固定 UUID 与 MISSION 常量一致）。"""
    from sqlalchemy import insert

    async with SqlAlchemyUnitOfWork(sf) as uow:
        await uow._session.execute(
            insert(ShoppingMissionRow).values(
                id=MISSION,
                owner_id=OWNER,
                stage="searching",
                constraints_json={},
                constraints_version=1,
            )
        )
        await uow.commit()


async def _insert_run(sf, status: str) -> None:
    async with SqlAlchemyUnitOfWork(sf) as uow:
        await uow.recommendation_runs.save(mission_id=MISSION, run_id=RUN, payload={"status": status})
        await uow.commit()


async def _get_run_status(sf) -> str | None:
    async with SqlAlchemyUnitOfWork(sf) as uow:
        run = await uow.recommendation_runs.get(RUN)
        return run["status"] if run else None


@pytest.mark.asyncio
async def test_startup_recovers_stale_runs_to_interrupted(db) -> None:
    await _insert_mission(db)
    await _insert_run(db, "accepted")
    dispatcher = InProcessRunDispatcher(SlowRunner(delay=0), db)
    await dispatcher.start()
    assert await _get_run_status(db) == "interrupted"


@pytest.mark.asyncio
async def test_graceful_stop_cancels_slow_run_and_marks_interrupted(db) -> None:
    await _insert_mission(db)
    dispatcher = InProcessRunDispatcher(SlowRunner(delay=10), db)
    await dispatcher.start()
    await dispatcher.dispatch(
        owner_id=OWNER, mission_id=MISSION, run_id=RUN, constraints_version=1
    )
    await asyncio.sleep(0.1)  # 让后台任务启动
    await dispatcher.stop(grace_seconds=0.2)
    # 慢任务未能在 grace 内完成 → 取消并标记 interrupted
    assert await _get_run_status(db) == "interrupted"


@pytest.mark.asyncio
async def test_user_cancel_marks_run_cancelled(db) -> None:
    await _insert_mission(db)
    dispatcher = InProcessRunDispatcher(SlowRunner(delay=10), db)
    await dispatcher.start()
    await dispatcher.dispatch(
        owner_id=OWNER, mission_id=MISSION, run_id=RUN, constraints_version=1
    )
    await asyncio.sleep(0.1)
    assert await dispatcher.cancel(owner_id=OWNER, mission_id=MISSION, run_id=RUN) is True
    assert await _get_run_status(db) == "cancelled"
    await dispatcher.stop(grace_seconds=0.1)


@pytest.mark.asyncio
async def test_dispatch_after_stop_is_rejected(db) -> None:
    await _insert_mission(db)
    dispatcher = InProcessRunDispatcher(SlowRunner(delay=0), db)
    await dispatcher.start()
    await dispatcher.stop(grace_seconds=0.1)
    with pytest.raises(DispatcherNotAccepting):
        await dispatcher.dispatch(
            owner_id=OWNER, mission_id=MISSION, run_id=RUN, constraints_version=1
        )


@pytest.mark.asyncio
async def test_dispatcher_persists_release_observation(db) -> None:
    await _insert_mission(db)
    dispatcher = InProcessRunDispatcher(RolloutRunner(), db)
    await dispatcher.start()
    await dispatcher.dispatch(
        owner_id=OWNER,
        mission_id=MISSION,
        run_id=RUN,
        constraints_version=1,
    )
    await dispatcher.stop(grace_seconds=1)
    async with SqlAlchemyUnitOfWork(db) as uow:
        events = await uow.events.list_since(mission_id=MISSION)
    observed = next(item for item in events if item["event_type"] == "run.release_observed")

    assert observed["payload"]["run_id"] == RUN
    assert observed["payload"]["feature_flags"]["execution_path"] == "explicit_v2"
    assert observed["payload"]["feature_flags"]["release_state"] == "full"
    assert isinstance(observed["payload"]["run_latency_ms"], int)
    assert observed["payload"]["run_latency_ms"] >= 0


@pytest.mark.asyncio
async def test_dispatcher_persists_failed_release_before_marking_run_failed(db) -> None:
    await _insert_mission(db)
    dispatcher = InProcessRunDispatcher(FailingRolloutRunner(), db)
    await dispatcher.start()
    await dispatcher.dispatch(
        owner_id=OWNER,
        mission_id=MISSION,
        run_id=RUN,
        constraints_version=1,
    )
    await dispatcher.stop(grace_seconds=1)
    async with SqlAlchemyUnitOfWork(db) as uow:
        events = await uow.events.list_since(mission_id=MISSION)
    observed = next(item for item in events if item["event_type"] == "run.release_observed")

    assert await _get_run_status(db) == "failed"
    assert observed["payload"]["status"] == "failed"
    assert observed["payload"]["feature_flags"] == {
        "execution_path": "explicit_v2",
        "release_state": "full",
        "qualification_profile_version": "ontology-rules-v10",
    }
    assert observed["payload"]["run_latency_ms"] >= 0
