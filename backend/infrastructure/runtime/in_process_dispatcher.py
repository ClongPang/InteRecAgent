"""进程内运行调度实现（实现 RunDispatcher Port，BE-009）。"""
from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...application.ports import MissionRunner
from ..persistence.unit_of_work import SqlAlchemyUnitOfWork


class InProcessRunDispatcher:
    """进程内调度：后台任务执行注入的 MissionRunner，运行状态持久化到推荐运行表。

    - dispatch 先持久化 accepted，再创建后台任务；不阻塞 HTTP 请求。
    - 优雅关闭 stop() 停止接收新 Run，在 grace 内 drain；剩余取消并标记 interrupted。
    - 启动 start() 恢复遗留 accepted/running → interrupted（前端可显式重试）。
    """

    def __init__(
        self,
        runner: MissionRunner,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        grace_seconds: float = 5.0,
    ) -> None:
        self._runner = runner
        self._session_factory = session_factory
        self._grace = grace_seconds
        self._tasks: set[asyncio.Task] = set()
        self._accepting = False

    async def start(self) -> None:
        self._accepting = True
        # 启动恢复：遗留 accepted/running → interrupted
        async with SqlAlchemyUnitOfWork(self._session_factory) as uow:
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
        # 先持久化 accepted（事件已由 Command Service 写入）
        async with SqlAlchemyUnitOfWork(self._session_factory) as uow:
            await uow.recommendation_runs.save(
                mission_id=mission_id, run_id=run_id, payload={"status": "accepted"}
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
        task.add_done_callback(self._tasks.discard)

    async def _execute(
        self, owner_id: str, mission_id: str, run_id: str, constraints_version: int
    ) -> None:
        await self._mark_run(mission_id, run_id, "running")
        try:
            await self._runner.run(
                owner_id=owner_id,
                mission_id=mission_id,
                run_id=run_id,
                constraints_version=constraints_version,
            )
        except Exception:
            # 终态由 persist 节点写入；异常时标记 failed，不吞掉
            await self._mark_run(mission_id, run_id, "failed")
            raise

    async def _mark_run(self, mission_id: str, run_id: str, status: str) -> None:
        async with SqlAlchemyUnitOfWork(self._session_factory) as uow:
            await uow.recommendation_runs.save(
                mission_id=mission_id, run_id=run_id, payload={"status": status}
            )
            await uow.commit()

    async def stop(self, grace_seconds: float | None = None) -> None:
        self._accepting = False
        grace = grace_seconds if grace_seconds is not None else self._grace
        if self._tasks:
            _done, pending = await asyncio.wait(self._tasks, timeout=grace)
            for task in pending:
                task.cancel()
        # 未完成的 accepted/running → interrupted
        async with SqlAlchemyUnitOfWork(self._session_factory) as uow:
            await uow.recommendation_runs.interrupt_stale()
            await uow.commit()
