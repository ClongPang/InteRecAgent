from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from ...domain.models import utcnow


class Base(DeclarativeBase):
    pass


class ShoppingMissionRow(Base):
    """任务聚合根（DAT-001）。constraints_json 存当前约束快照，constraints_version 单调递增。"""

    __tablename__ = "shopping_missions"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True))
    stage: Mapped[str] = mapped_column(String(20), default="collecting")
    constraints_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    constraints_version: Mapped[int] = mapped_column(Integer, default=1)
    active_run_id: Mapped[uuid.UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (
        Index("ix_shopping_missions_owner_updated_id", "owner_id", "updated_at", "id"),
    )


class MissionEventRow(Base):
    """任务事件流（审计 + SSE + 版本可追溯）。sequence 在任务内递增。"""

    __tablename__ = "mission_events"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    mission_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("shopping_missions.id", ondelete="CASCADE")
    )
    sequence: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(50))
    payload_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_mission_events_mission_sequence", "mission_id", "sequence"),
    )


class ProductSnapshotRow(Base):
    """商品快照（DAT-002）。原始 payload 只存受控 JSONB，不直接返回前端。"""

    __tablename__ = "product_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(30))
    source_product_id: Mapped[str] = mapped_column(String(64))
    contract_version: Mapped[str] = mapped_column(String(20))
    raw_json: Mapped[dict] = mapped_column(JSONB)
    normalized_json: Mapped[dict] = mapped_column(JSONB)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_product_snapshots_source_srcid_fetched", "source", "source_product_id", "fetched_at"),
    )


class FxSnapshotRow(Base):
    """汇率快照（DAT-001）。rate_date 为汇率源日期，fetched_at 为本地抓取时间。"""

    __tablename__ = "fx_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    base: Mapped[str] = mapped_column(String(3))
    quote: Mapped[str] = mapped_column(String(3))
    rate: Mapped[float] = mapped_column()
    source: Mapped[str] = mapped_column(String(30))
    rate_date: Mapped[str] = mapped_column(String(20))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CandidateSetRow(Base):
    """候选集（DAT-004）。记录 constraints_version 下的保留/排除原因与排序输入。"""

    __tablename__ = "candidate_sets"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    mission_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("shopping_missions.id", ondelete="CASCADE")
    )
    run_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True))
    constraints_version: Mapped[int] = mapped_column(Integer)
    candidates_json: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_candidate_sets_mission_version", "mission_id", "constraints_version"),
    )


class RecommendationRunRow(Base):
    """推荐运行记录。candidate_set_id 在候选生成前允许为空，完成/降级时非空。"""

    __tablename__ = "recommendation_runs"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    mission_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("shopping_missions.id", ondelete="CASCADE")
    )
    candidate_set_id: Mapped[uuid.UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="accepted")
    draft_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    final_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IdempotencyRecordRow(Base):
    """幂等记录（BE-010）。同一 owner/key 与相同请求指纹重试返回原响应。"""

    __tablename__ = "idempotency_records"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int] = mapped_column(Integer)
    response_json: Mapped[dict] = mapped_column(JSONB)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key", name="uq_idempotency_owner_key"),
    )
