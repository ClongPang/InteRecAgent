from __future__ import annotations

from collections.abc import Callable
from uuid import uuid4

from ...domain.models import utcnow
from ..dto import MissionConstraints, MissionStage, ShoppingMission
from ..errors import (
    InvalidComparison,
    MissionNotFound,
    MissionVersionConflict,
    NothingToUndo,
)
from ..ports import RunDispatcher, UnitOfWork


class MissionCommandService:
    """Mission 命令入口。只依赖 Application Port（uow_factory + RunDispatcher），
    不导入 backend.agent 或 backend.infrastructure（ARC-002/DEC-009）。

    每个命令打开独立事务边界，保证事件与状态变更原子提交。
    """

    def __init__(
        self,
        *,
        uow_factory: Callable[[], UnitOfWork],
        dispatcher: RunDispatcher,
    ) -> None:
        self._uow_factory = uow_factory
        self._dispatcher = dispatcher

    async def get_mission(self, *, owner_id: str, mission_id: str) -> ShoppingMission:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
        if mission is None:
            raise MissionNotFound(mission_id)
        return mission

    async def list_missions(
        self, *, owner_id: str, limit: int = 20, offset: int = 0
    ) -> list[ShoppingMission]:
        async with self._uow_factory() as uow:
            return await uow.missions.list(owner_id=owner_id, limit=limit, offset=offset)

    async def create_mission(self, *, owner_id: str, title: str) -> ShoppingMission:
        async with self._uow_factory() as uow:
            mission = await uow.missions.create(owner_id=owner_id, title=title)
            await uow.commit()
            return mission

    async def submit_message(
        self,
        *,
        owner_id: str,
        mission_id: str,
        text: str,
        constraints_version: int,
    ) -> str:
        """追加消息并调度新运行（返回 run_id）。版本不匹配时抛版本冲突，
        不允许旧版本运行覆盖新版本任务（AGT-005）。事件先持久化再调度。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected constraints_version {constraints_version}, got {mission.constraints_version}"
                )
            run_id = str(uuid4())
            await uow.events.append(
                mission_id=mission_id,
                event_type="message.received",
                payload={
                    "run_id": run_id,
                    "text": text,
                    "constraints_version": constraints_version,
                },
            )
            await uow.commit()
        await self._dispatcher.dispatch(
            owner_id=owner_id,
            mission_id=mission_id,
            run_id=run_id,
            constraints_version=constraints_version,
        )
        return run_id

    async def update_constraints(
        self,
        *,
        owner_id: str,
        mission_id: str,
        constraints_version: int,
        constraints: MissionConstraints,
    ) -> str:
        """显式修改约束（PATCH）。产生新版本并调度运行；旧版本冲突时拒绝（AGT-005）。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            before = mission.constraints
            run_id = str(uuid4())
            updated = mission.model_copy(
                update={
                    "constraints": constraints,
                    "stage": MissionStage.SEARCHING,
                    "constraints_version": mission.constraints_version + 1,
                    "active_run_id": run_id,
                    "updated_at": utcnow(),
                }
            )
            await uow.missions.save(updated, expected_version=constraints_version)
            await uow.events.append(
                mission_id=mission_id,
                event_type="constraints.updated",
                payload={
                    "run_id": run_id,
                    "before": before.model_dump(mode="json"),
                    "after": constraints.model_dump(mode="json"),
                    "constraints_version": updated.constraints_version,
                },
            )
            await uow.commit()
        await self._dispatcher.dispatch(
            owner_id=owner_id,
            mission_id=mission_id,
            run_id=run_id,
            constraints_version=constraints_version,
        )
        return run_id

    async def undo(self, *, owner_id: str, mission_id: str, constraints_version: int) -> str:
        """撤销最近一次可撤销条件变更，产生新版本（AC-015/BUS-008）。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            events = await uow.events.list_since(mission_id=mission_id)
            for event in reversed(events):
                if event["event_type"] != "constraints.updated":
                    continue
                before = MissionConstraints(**event["payload"]["before"])
                run_id = str(uuid4())
                updated = mission.model_copy(
                    update={
                        "constraints": before,
                        "stage": MissionStage.SEARCHING,
                        "constraints_version": mission.constraints_version + 1,
                        "active_run_id": run_id,
                        "updated_at": utcnow(),
                    }
                )
                await uow.missions.save(updated, expected_version=constraints_version)
                await uow.events.append(
                    mission_id=mission_id,
                    event_type="constraints.undo",
                    payload={
                        "run_id": run_id,
                        "restored": before.model_dump(mode="json"),
                        "constraints_version": updated.constraints_version,
                    },
                )
                await uow.commit()
                break
            else:
                raise NothingToUndo(mission_id)
        await self._dispatcher.dispatch(
            owner_id=owner_id,
            mission_id=mission_id,
            run_id=run_id,
            constraints_version=constraints_version,
        )
        return run_id

    async def set_comparison(
        self,
        *,
        owner_id: str,
        mission_id: str,
        constraints_version: int,
        snapshot_ids: list[str],
    ) -> ShoppingMission:
        """保存 2–4 件比较集合（BUS-005/FE-007）。比较不推进约束版本，但做乐观版本校验。"""
        if not 2 <= len(snapshot_ids) <= 4:
            raise InvalidComparison(f"比较集合必须是 2–4 件，收到 {len(snapshot_ids)}")
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            updated = mission.model_copy(
                update={"comparison_snapshot_ids": snapshot_ids, "updated_at": utcnow()}
            )
            await uow.missions.save(updated, expected_version=constraints_version)
            await uow.events.append(
                mission_id=mission_id,
                event_type="comparison.updated",
                payload={
                    "snapshot_ids": snapshot_ids,
                    "constraints_version": constraints_version,
                },
            )
            await uow.commit()
            return updated

    async def get_candidates(self, *, owner_id: str, mission_id: str) -> dict | None:
        """读取当前候选集（DAT-004 展示数据）。跨 owner 一律 404。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.candidate_set_id is None:
                return None
            return await uow.candidate_sets.get(mission.candidate_set_id)

    async def get_recommendation(self, *, owner_id: str, mission_id: str) -> dict | None:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.recommendation_run_id is None:
                return None
            return await uow.recommendation_runs.get(mission.recommendation_run_id)

    async def get_snapshot(self, *, snapshot_id: str) -> dict | None:
        async with self._uow_factory() as uow:
            return await uow.products.get(snapshot_id)

    async def list_events(
        self, *, owner_id: str, mission_id: str, after: int = 0
    ) -> list[dict]:
        """事件流（OBS-003）。跨 owner 一律 404。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            return await uow.events.list_since(mission_id=mission_id, sequence=after)
