"""进程内运行调度实现（实现 RunDispatcher Port，BE-009）。"""
from __future__ import annotations

import asyncio
import logging
import time

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...application.dto import MissionStage, RunnerResult, RunnerStatus, TurnPhase
from ...application.errors import DispatcherNotAccepting
from ...application.ports import MissionEventBroker, MissionRunner, RunTextHub
from ...domain.models import utcnow
from ..persistence.unit_of_work import SqlAlchemyUnitOfWork

logger = logging.getLogger(__name__)


class InProcessRunDispatcher:
    """
    进程内调度：后台任务执行注入的 MissionRunner，运行状态持久化到推荐运行表。
    单进程假设：start() 将遗留 accepted/running 标为 interrupted（崩溃恢复）。
    多 worker 需换成外部队列，不可共享这套 interrupt_stale。
    """

    def __init__(
        self,
        runner: MissionRunner,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        broker: MissionEventBroker | None = None,
        text_hub: RunTextHub | None = None,
        grace_seconds: float = 5.0,
    ) -> None:
        self._runner = runner
        self._session_factory = session_factory
        self._broker = broker
        self._text_hub = text_hub
        self._grace = grace_seconds
        self._tasks: set[asyncio.Task] = set()
        self._by_run: dict[str, asyncio.Task] = {}
        self._user_cancels: set[str] = set()
        self._accepting = True

    def _uow(self) -> SqlAlchemyUnitOfWork:
        return SqlAlchemyUnitOfWork(self._session_factory, broker=self._broker)

    async def start(self) -> None:
        self._accepting = True
        async with self._uow() as uow:
            await uow.recommendation_runs.interrupt_stale()
            await uow.commit()

    async def dispatch(
        self,
        *,
        owner_id: str,
        mission_id: str,
        run_id: str,
        constraints_version: int,
    ) -> None:
        if not self._accepting:
            raise DispatcherNotAccepting("调度器已停止接收新运行")
        if self._text_hub is not None:
            self._text_hub.open(run_id)
        async with self._uow() as uow:
            await uow.recommendation_runs.save(
                mission_id=mission_id, run_id=run_id, payload={"status": "accepted"}
            )
            await uow.events.append(
                mission_id=mission_id,
                event_type="run.accepted",
                payload={
                    "mission_id": mission_id,
                    "run_id": run_id,
                    "constraints_version": constraints_version,
                },
            )
            await uow.commit()
        task = asyncio.create_task(
            self._execute(
                owner_id=owner_id,
                mission_id=mission_id,
                run_id=run_id,
                constraints_version=constraints_version,
            )
        )
        self._tasks.add(task)
        self._by_run[run_id] = task
        task.add_done_callback(lambda done: self._forget(run_id, done))

    def _forget(self, run_id: str, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if self._by_run.get(run_id) is task:
            self._by_run.pop(run_id, None)

    async def cancel(self, *, owner_id: str, mission_id: str, run_id: str) -> bool:
        del owner_id, mission_id
        task = self._by_run.get(run_id)
        if task is None or task.done():
            return False
        self._user_cancels.add(run_id)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        self._user_cancels.discard(run_id)
        return True

    async def _execute(
        self, owner_id: str, mission_id: str, run_id: str, constraints_version: int
    ) -> None:
        started_at = time.perf_counter()
        metadata_provider = getattr(self._runner, "release_metadata", None)
        release_metadata = (
            dict(metadata_provider(mission_id)) if callable(metadata_provider) else {}
        )
        await self._mark_run(mission_id, run_id, "running")
        try:
            result = await self._runner.run(
                owner_id=owner_id,
                mission_id=mission_id,
                run_id=run_id,
                constraints_version=constraints_version,
            )
            if not result.metadata and release_metadata:
                result = result.model_copy(update={"metadata": release_metadata})
            run_latency_ms = max(0, round((time.perf_counter() - started_at) * 1000))
            await self._record_release_observation(
                mission_id,
                run_id,
                result,
                run_latency_ms=run_latency_ms,
            )
        except asyncio.CancelledError:
            if run_id in self._user_cancels:
                await self._mark_cancelled(owner_id, mission_id, run_id)
                self._user_cancels.discard(run_id)
            if self._text_hub is not None:
                self._text_hub.abort(run_id)
            raise
        except Exception:
            logger.exception(
                "mission run failed",
                extra={"mission_id": mission_id, "run_id": run_id},
            )
            if release_metadata:
                try:
                    await self._record_release_observation(
                        mission_id,
                        run_id,
                        RunnerResult(
                            status=RunnerStatus.FAILED,
                            metadata=release_metadata,
                        ),
                        run_latency_ms=max(
                            0, round((time.perf_counter() - started_at) * 1000)
                        ),
                    )
                except Exception:
                    logger.exception(
                        "failed to persist release failure observation",
                        extra={"mission_id": mission_id, "run_id": run_id},
                    )
            await self._mark_run(mission_id, run_id, "failed")
            await self._mark_mission_failed(owner_id, mission_id, run_id)
            if self._text_hub is not None:
                self._text_hub.abort(run_id)

    async def _record_release_observation(
        self,
        mission_id: str,
        run_id: str,
        result: RunnerResult,
        *,
        run_latency_ms: int,
    ) -> None:
        feature_flags = result.metadata.get("feature_flags") if result.metadata else None
        if not isinstance(feature_flags, dict) or not feature_flags.get("execution_path"):
            return
        async with self._uow() as uow:
            await uow.events.append(
                mission_id=mission_id,
                event_type="run.release_observed",
                payload={
                    "run_id": run_id,
                    "status": result.status.value,
                    "candidate_set_id": result.candidate_set_id,
                    "recommendation_run_id": result.recommendation_run_id,
                    "run_latency_ms": run_latency_ms,
                    "feature_flags": feature_flags,
                },
            )
            await uow.commit()

    async def _mark_run(self, mission_id: str, run_id: str, status: str) -> None:
        async with self._uow() as uow:
            await uow.recommendation_runs.save(
                mission_id=mission_id, run_id=run_id, payload={"status": status}
            )
            await uow.commit()

    async def _mark_cancelled(self, owner_id: str, mission_id: str, run_id: str) -> None:
        async with self._uow() as uow:
            run = await uow.recommendation_runs.get(run_id)
            if run is not None and run["status"] in {"completed", "superseded", "failed", "cancelled"}:
                return
            await uow.recommendation_runs.save(
                mission_id=mission_id, run_id=run_id, payload={"status": "cancelled"}
            )
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is not None and mission.active_run_id == run_id:
                updated = mission.model_copy(
                    update={"turn_phase": TurnPhase.IDLE, "updated_at": utcnow()}
                )
                await uow.missions.save(updated)
            await uow.events.append(
                mission_id=mission_id,
                event_type="run.cancelled",
                payload={"run_id": run_id},
            )
            await uow.commit()

    async def _mark_mission_failed(self, owner_id: str, mission_id: str, run_id: str) -> None:
        async with self._uow() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None or mission.active_run_id != run_id:
                return
            updated = mission.model_copy(
                update={
                    "stage": MissionStage.FAILED,
                    "turn_phase": TurnPhase.IDLE,
                    "updated_at": utcnow(),
                }
            )
            await uow.missions.save(updated)
            await uow.events.append(
                mission_id=mission_id,
                event_type="run.failed",
                payload={"run_id": run_id},
            )
            await uow.commit()

    async def stop(self, grace_seconds: float | None = None) -> None:
        self._accepting = False
        grace = grace_seconds if grace_seconds is not None else self._grace
        if self._tasks:
            _done, pending = await asyncio.wait(self._tasks, timeout=grace)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        async with self._uow() as uow:
            await uow.recommendation_runs.interrupt_stale()
            await uow.commit()
