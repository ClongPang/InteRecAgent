from __future__ import annotations

from collections.abc import Callable
from uuid import uuid4

from ...domain.models import utcnow
from ..dto import MissionConstraints, MissionStage, ShoppingMission
from ..dto.public import (
    CandidateSetView,
    MissionView,
    ProductCandidate,
    RecommendationView,
    mission_view,
)
from ..errors import (
    InvalidComparison,
    MissionNotFound,
    MissionVersionConflict,
    NothingToUndo,
    RecommendationNotFound,
    SnapshotNotFound,
)
from ..ports import RunDispatcher, UnitOfWork
from .present import product_candidate_from_record, product_candidate_from_snapshot


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

    async def get_mission_view(self, *, owner_id: str, mission_id: str) -> MissionView:
        return mission_view(await self.get_mission(owner_id=owner_id, mission_id=mission_id))

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
            updated = mission.model_copy(
                update={
                    "stage": MissionStage.SEARCHING,
                    "active_run_id": run_id,
                    "updated_at": utcnow(),
                }
            )
            await uow.missions.save(updated, expected_version=constraints_version)
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
            constraints_version=updated.constraints_version,
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
            constraints_version=updated.constraints_version,
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
        if len(set(snapshot_ids)) != len(snapshot_ids):
            raise InvalidComparison("比较集合不能包含重复商品")
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            valid_ids = await self._comparison_id_universe(uow, mission)
            unknown = [sid for sid in snapshot_ids if sid not in valid_ids]
            if unknown:
                raise InvalidComparison("比较集合必须来自当前候选快照")
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

    async def get_candidates(self, *, owner_id: str, mission_id: str) -> CandidateSetView:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.candidate_set_id is None:
                return CandidateSetView()
            payload = await uow.candidate_sets.get(mission.candidate_set_id)
        return self._candidate_set_view(payload)

    async def get_recommendation(self, *, owner_id: str, mission_id: str) -> RecommendationView:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.recommendation_run_id is None:
                raise RecommendationNotFound(mission_id)
            run = await uow.recommendation_runs.get(mission.recommendation_run_id)
            if run is None or not run.get("draft_json"):
                raise RecommendationNotFound(mission_id)
            draft = run["draft_json"]
            snapshot_map: dict[str, str] = {}
            if run.get("candidate_set_id"):
                candidates = await uow.candidate_sets.get(run["candidate_set_id"])
                snapshot_map = (candidates or {}).get("snapshot_map") or {}

            async def _load(eid: str | None) -> ProductCandidate | None:
                if not eid:
                    return None
                sid = snapshot_map.get(eid, eid)
                snap = await uow.products.get(sid)
                if snap is None:
                    return None
                return product_candidate_from_snapshot(snap)

            primary = await _load(draft.get("primary_snapshot_id"))
            alternatives: list[ProductCandidate] = []
            for alt_id in draft.get("alternative_snapshot_ids") or []:
                item = await _load(alt_id)
                if item is not None:
                    alternatives.append(item)
            cited = []
            for eid in draft.get("cited_evidence_ids") or []:
                sid = snapshot_map.get(eid, eid)
                if await uow.products.get(sid):
                    cited.append(sid)
        if primary is None:
            raise RecommendationNotFound(mission_id)
        return RecommendationView(
            run_id=mission.recommendation_run_id,
            status=run["status"],
            primary=primary,
            alternatives=alternatives,
            rationale=list(draft.get("rationale") or []),
            tradeoffs=list(draft.get("tradeoffs") or []),
            cited_evidence_ids=cited,
        )

    async def get_snapshot(self, *, snapshot_id: str) -> ProductCandidate:
        async with self._uow_factory() as uow:
            snap = await uow.products.get(snapshot_id)
        if snap is None:
            raise SnapshotNotFound(snapshot_id)
        candidate = product_candidate_from_snapshot(snap)
        if candidate is None:
            raise SnapshotNotFound(snapshot_id)
        return candidate

    async def list_events(
        self, *, owner_id: str, mission_id: str, after: int = 0
    ) -> list[dict]:
        """事件流（OBS-003）。跨 owner 一律 404。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            return await uow.events.list_since(mission_id=mission_id, sequence=after)

    @staticmethod
    def _candidate_set_view(payload: dict | None) -> CandidateSetView:
        if not payload:
            return CandidateSetView()
        ranked: list[ProductCandidate] = []
        for index, item in enumerate(payload.get("ranked") or [], start=1):
            candidate = product_candidate_from_record(item, rank=index)
            if candidate is not None:
                ranked.append(candidate)
        return CandidateSetView(
            ranked=ranked,
            fx_snapshot_ids=list(payload.get("fx_snapshot_ids") or []),
        )

    @staticmethod
    async def _comparison_id_universe(uow: UnitOfWork, mission: ShoppingMission) -> set[str]:
        """比较集只接受当前候选的 snapshot_id。"""
        if mission.candidate_set_id is None:
            return set()
        payload = await uow.candidate_sets.get(mission.candidate_set_id)
        if not payload:
            return set()
        return {
            str(item["snapshot_id"])
            for item in payload.get("ranked") or []
            if item.get("snapshot_id")
        }
