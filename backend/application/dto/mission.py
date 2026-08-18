from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from ...domain.models import utcnow


class MissionStage(StrEnum):
    """任务阶段（规格 §6.2 允许集合）。"""

    COLLECTING = "collecting"
    CLARIFYING = "clarifying"
    SEARCHING = "searching"
    RANKING = "ranking"
    READY = "ready"
    DEGRADED = "degraded"
    FAILED = "failed"


class MissionConstraints(BaseModel):
    """当前生效的购物约束。country_code 只表示商品市场，不表示配送目的地。"""

    query: str | None = None
    budget_cny: float | None = None
    markets: list[str] = Field(default_factory=lambda: ["US"])
    preference: str = "balanced"
    only_in_stock: bool = False
    excluded_terms: list[str] = Field(default_factory=list)


def next_constraints_version(current: int, before: MissionConstraints, after: MissionConstraints) -> int:
    """约束内容变化才递增。PATCH/undo 由命令层递增；消息合并由 persist 调用本函数。"""
    return current if before == after else current + 1


class ShoppingMission(BaseModel):
    """任务业务聚合根（跨层表示；P2 持久化时 ORM 映射到 shopping_missions 表）。"""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    title: str
    stage: MissionStage = MissionStage.COLLECTING
    constraints_version: int = Field(
        default=1,
        description="仅约束内容变化时递增；不是每次检索/运行的序号",
    )
    constraints: MissionConstraints = Field(default_factory=MissionConstraints)
    active_run_id: str | None = None
    candidate_set_id: str | None = None
    comparison_snapshot_ids: list[str] = Field(default_factory=list)
    recommendation_run_id: str | None = None
    warnings: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
