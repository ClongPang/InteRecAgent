"""对外 BFF 契约（规格 §6.2–6.7）。Application 与 API 共用，避免两套 Schema 漂移。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from .mission import DialogueState, MissionConstraints, MissionStage, ShoppingMission, TurnPhase

SSE_PUBLIC_EVENTS = frozenset(
    {
        "run.accepted",
        "clarification.required",
        "search.started",
        "products.received",
        "fx.received",
        "candidates.ranked",
        "recommendation.ready",
        "run.degraded",
        "run.superseded",
        "run.failed",
        "agent.message",
        "message.received",
        "constraints.updated",
        "constraints.undo",
        "comparison.updated",
    }
)


class MissionView(BaseModel):
    """任务投影。不含 owner_id，避免把隔离键当成对外身份。"""

    id: str
    title: str
    stage: MissionStage
    constraints_version: int
    constraints: MissionConstraints
    active_run_id: str | None = None
    candidate_set_id: str | None = None
    comparison_snapshot_ids: list[str] = Field(default_factory=list)
    recommendation_run_id: str | None = None
    warnings: list[str] = Field(default_factory=list)
    turn_phase: TurnPhase = TurnPhase.IDLE
    dialogue: DialogueState = Field(default_factory=DialogueState)
    created_at: datetime
    updated_at: datetime


class NativePrice(BaseModel):
    amount: float
    currency: str


class EstimatedCny(BaseModel):
    amount: float
    rate: float
    source: str
    rate_date: str
    fetched_at: datetime | None = None


class ProductCandidate(BaseModel):
    """可展示的标准化商品。比较、推荐、详情共用 snapshot_id 作为稳定身份。"""

    snapshot_id: str
    source: str = "buywhere"
    source_product_id: str
    title: str
    merchant: str | None = None
    market: str | None = None
    native_price: NativePrice
    estimated_cny: EstimatedCny | None = None
    fx_failed: bool = False
    brand: None = None
    rating: None = None
    review_count: None = None
    availability: str = "unknown"
    specs: list[str] = Field(default_factory=list)
    derived_fields: list[str] = Field(default_factory=list)
    unavailable_fields: list[str] = Field(default_factory=list)
    merchant_url: str | None = None
    source_updated_at: datetime | None = None
    rank: int | None = None
    decision_reasons: list[str] = Field(default_factory=list)


class CandidateSetView(BaseModel):
    ranked: list[ProductCandidate] = Field(default_factory=list)
    fx_snapshot_ids: list[str] = Field(default_factory=list)


class RecommendationView(BaseModel):
    """从快照回填后的最终推荐，不直接返回模型草稿。"""

    run_id: str
    status: str
    primary: ProductCandidate | None = None
    alternatives: list[ProductCandidate] = Field(default_factory=list)
    rationale: list[str] = Field(default_factory=list)
    tradeoffs: list[str] = Field(default_factory=list)
    cited_evidence_ids: list[str] = Field(default_factory=list)


class CreateMissionResponse(BaseModel):
    mission: MissionView
    run_id: str
    constraints_version: int


class MissionListResponse(BaseModel):
    missions: list[MissionView]
    limit: int
    offset: int


def mission_view(mission: ShoppingMission) -> MissionView:
    return MissionView.model_validate(mission.model_dump())
