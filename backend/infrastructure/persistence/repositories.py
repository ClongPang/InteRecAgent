from __future__ import annotations

import uuid

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ...application.dto import DialogueState, MissionConstraints, MissionStage, ShoppingMission, TurnPhase
from ...application.dto.belief import PreferenceBelief
from ...application.errors import MissionVersionConflict
from ...domain.models import FxSnapshot, NormalizedProduct
from .orm import (
    CandidateSetRow,
    FxSnapshotRow,
    IdempotencyRecordRow,
    MissionEventRow,
    ProductSnapshotRow,
    RecommendationRunRow,
    ShoppingMissionRow,
)


def _mission_payload(mission: ShoppingMission) -> dict:
    """ShoppingMission 业务字段 → constraints_json（title/constraints/推荐与候选指针）。"""
    return {
        "title": mission.title,
        "constraints": mission.constraints.model_dump(mode="json"),
        "candidate_set_id": mission.candidate_set_id,
        "comparison_snapshot_ids": mission.comparison_snapshot_ids,
        "recommendation_run_id": mission.recommendation_run_id,
        "warnings": mission.warnings,
        "turn_phase": mission.turn_phase.value,
        "dialogue": mission.dialogue.model_dump(mode="json"),
        "belief": mission.belief.model_dump(mode="json"),
    }


def _row_to_mission(row: ShoppingMissionRow) -> ShoppingMission:
    data = row.constraints_json or {}
    return ShoppingMission(
        id=str(row.id),
        owner_id=str(row.owner_id),
        title=data.get("title") or "未命名选购",
        stage=MissionStage(row.stage) if row.stage else MissionStage.COLLECTING,
        constraints_version=row.constraints_version,
        constraints=MissionConstraints(**(data.get("constraints") or {})),
        active_run_id=str(row.active_run_id) if row.active_run_id else None,
        candidate_set_id=data.get("candidate_set_id"),
        comparison_snapshot_ids=data.get("comparison_snapshot_ids") or [],
        recommendation_run_id=data.get("recommendation_run_id"),
        warnings=data.get("warnings") or [],
        turn_phase=TurnPhase(data["turn_phase"]) if data.get("turn_phase") else TurnPhase.IDLE,
        dialogue=DialogueState(**(data.get("dialogue") or {})),
        belief=PreferenceBelief(**(data.get("belief") or {})),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class PostgresMissionRepository:
    """任务仓储实现。只返回 ShoppingMission DTO，不暴露 ORM 行（ARC-003）。"""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, *, owner_id: str, mission_id: str) -> ShoppingMission | None:
        try:
            uid = uuid.UUID(mission_id)
        except ValueError:
            return None
        row = await self._session.get(ShoppingMissionRow, uid)
        if row is None or str(row.owner_id) != owner_id:
            return None
        return _row_to_mission(row)

    async def list(
        self, *, owner_id: str, limit: int = 20, offset: int = 0
    ) -> list[ShoppingMission]:
        stmt = (
            select(ShoppingMissionRow)
            .where(ShoppingMissionRow.owner_id == uuid.UUID(owner_id))
            .order_by(ShoppingMissionRow.updated_at.desc(), ShoppingMissionRow.id.asc())
            .limit(limit)
            .offset(offset)
        )
        rows = (await self._session.scalars(stmt)).all()
        return [_row_to_mission(r) for r in rows]

    async def create(self, *, owner_id: str, title: str) -> ShoppingMission:
        mission = ShoppingMission(owner_id=owner_id, title=title)
        row = ShoppingMissionRow(
            owner_id=uuid.UUID(owner_id),
            stage=mission.stage.value,
            constraints_json=_mission_payload(mission),
            constraints_version=1,
        )
        self._session.add(row)
        await self._session.flush()
        return _row_to_mission(row)

    async def save(self, mission: ShoppingMission, *, expected_version: int | None = None) -> None:
        """写回任务。expected_version 非空时做版本条件更新；行版本不匹配抛冲突（DAT-005）。"""
        values = {
            "stage": mission.stage.value,
            "constraints_json": _mission_payload(mission),
            "constraints_version": mission.constraints_version,
            "active_run_id": uuid.UUID(mission.active_run_id) if mission.active_run_id else None,
            "updated_at": mission.updated_at,
        }
        stmt = update(ShoppingMissionRow).where(ShoppingMissionRow.id == uuid.UUID(mission.id))
        if expected_version is not None:
            stmt = stmt.where(ShoppingMissionRow.constraints_version == expected_version)
        result = await self._session.execute(stmt.values(**values))
        if expected_version is not None and result.rowcount == 0:
            raise MissionVersionConflict(
                f"mission {mission.id} 约束版本已变化，期望 {expected_version}"
            )


class PostgresMissionEventRepository:
    """任务事件仓储实现。sequence 在任务内单调递增。"""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def append(self, *, mission_id: str, event_type: str, payload: dict) -> int:
        mid = uuid.UUID(mission_id)
        # 锁住任务行，使同一 mission 的 sequence 分配串行化（配合唯一约束）。
        await self._session.execute(
            select(ShoppingMissionRow.id).where(ShoppingMissionRow.id == mid).with_for_update()
        )
        max_seq = await self._session.scalar(
            select(func.max(MissionEventRow.sequence)).where(MissionEventRow.mission_id == mid)
        )
        sequence = (max_seq or 0) + 1
        row = MissionEventRow(
            mission_id=uuid.UUID(mission_id),
            sequence=sequence,
            event_type=event_type,
            payload_json=payload,
        )
        self._session.add(row)
        await self._session.flush()
        return sequence

    async def list_since(self, *, mission_id: str, sequence: int = 0) -> list[dict]:
        stmt = (
            select(MissionEventRow)
            .where(
                MissionEventRow.mission_id == uuid.UUID(mission_id),
                MissionEventRow.sequence > sequence,
            )
            .order_by(MissionEventRow.sequence.asc())
        )
        rows = (await self._session.scalars(stmt)).all()
        return [
            {
                "sequence": r.sequence,
                "event_type": r.event_type,
                "payload": r.payload_json,
                "created_at": r.created_at,
            }
            for r in rows
        ]


class PostgresProductSnapshotRepository:
    """商品快照仓储实现（DAT-002）。raw 与 normalized 都入 JSONB，不返回 API。"""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def save(
        self, *, product: NormalizedProduct, raw_payload: dict, contract_version: str
    ) -> str:
        row = ProductSnapshotRow(
            source="buywhere",
            source_product_id=product.id,
            contract_version=contract_version,
            raw_json=raw_payload,
            normalized_json=product.model_dump(mode="json"),
        )
        self._session.add(row)
        await self._session.flush()
        return str(row.id)

    async def get(self, snapshot_id: str) -> dict | None:
        try:
            uid = uuid.UUID(snapshot_id)
        except ValueError:
            return None
        row = await self._session.get(ProductSnapshotRow, uid)
        if row is None:
            return None
        return {
            "id": str(row.id),
            "source": row.source,
            "source_product_id": row.source_product_id,
            "normalized": row.normalized_json,
            "fetched_at": row.fetched_at,
        }


class PostgresFxSnapshotRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def save(self, *, snapshot: FxSnapshot) -> str:
        row = FxSnapshotRow(
            base=snapshot.base,
            quote=snapshot.quote,
            rate=snapshot.rate,
            source=snapshot.source,
            rate_date=snapshot.date,
        )
        self._session.add(row)
        await self._session.flush()
        return str(row.id)


class PostgresCandidateSetRepository:
    """候选集仓储实现（DAT-004）。"""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def save(
        self, *, mission_id: str, run_id: str, constraints_version: int, payload: dict
    ) -> str:
        row = CandidateSetRow(
            mission_id=uuid.UUID(mission_id),
            run_id=uuid.UUID(run_id),
            constraints_version=constraints_version,
            candidates_json=payload,
        )
        self._session.add(row)
        await self._session.flush()
        return str(row.id)

    async def get(self, candidate_set_id: str) -> dict | None:
        row = await self._session.get(CandidateSetRow, uuid.UUID(candidate_set_id))
        return row.candidates_json if row else None


class PostgresRecommendationRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def save(self, *, mission_id: str, run_id: str, payload: dict) -> None:
        """按字段合并。标记 running/failed 时不得把已写入的 draft/candidate 抹成 None。"""
        rid = uuid.UUID(run_id)
        row = await self._session.get(RecommendationRunRow, rid)
        candidate_set_id = (
            uuid.UUID(payload["candidate_set_id"]) if payload.get("candidate_set_id") else None
        )
        if row is None:
            self._session.add(
                RecommendationRunRow(
                    id=rid,
                    mission_id=uuid.UUID(mission_id),
                    status=payload.get("status", "accepted"),
                    candidate_set_id=candidate_set_id,
                    draft_json=payload.get("draft_json"),
                    final_json=payload.get("final_json"),
                    completed_at=payload.get("completed_at"),
                )
            )
            return
        if "status" in payload:
            row.status = payload["status"]
        if "candidate_set_id" in payload:
            row.candidate_set_id = candidate_set_id
        if "draft_json" in payload:
            row.draft_json = payload["draft_json"]
        if "final_json" in payload:
            row.final_json = payload["final_json"]
        if "completed_at" in payload:
            row.completed_at = payload["completed_at"]

    async def mark_superseded(self, *, mission_id: str, run_id: str) -> None:
        await self._session.execute(
            update(RecommendationRunRow)
            .where(
                RecommendationRunRow.mission_id == uuid.UUID(mission_id),
                RecommendationRunRow.id == uuid.UUID(run_id),
            )
            .values(status="superseded")
        )

    async def get(self, run_id: str) -> dict | None:
        row = await self._session.get(RecommendationRunRow, uuid.UUID(run_id))
        if row is None:
            return None
        return {
            "status": row.status,
            "candidate_set_id": str(row.candidate_set_id) if row.candidate_set_id else None,
            "draft_json": row.draft_json,
            "final_json": row.final_json,
            "completed_at": row.completed_at,
        }

    async def interrupt_stale(self) -> int:
        """启动恢复：遗留 accepted/running 运行标记 interrupted（BE-009），允许前端重试。"""
        result = await self._session.execute(
            update(RecommendationRunRow)
            .where(RecommendationRunRow.status.in_(["accepted", "running"]))
            .values(status="interrupted")
        )
        return result.rowcount


class PostgresIdempotencyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, *, owner_id: str, key: str) -> dict | None:
        row = await self._session.scalar(
            select(IdempotencyRecordRow).where(
                IdempotencyRecordRow.owner_id == uuid.UUID(owner_id),
                IdempotencyRecordRow.idempotency_key == key,
            )
        )
        if row is None:
            return None
        return {
            "request_fingerprint": row.request_fingerprint,
            "response_status": row.response_status,
            "response_json": row.response_json,
        }

    async def save(self, *, owner_id: str, key: str, payload: dict) -> None:
        row = IdempotencyRecordRow(
            owner_id=uuid.UUID(owner_id),
            idempotency_key=key,
            request_fingerprint=payload["request_fingerprint"],
            response_status=payload["response_status"],
            response_json=payload["response_json"],
            expires_at=payload["expires_at"],
        )
        self._session.add(row)
