from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from ...domain.models import DEFAULT_MARKETS, utcnow
from .belief import PreferenceBelief
from .goal import ShoppingGoal


class MissionStage(StrEnum):
    """任务阶段。searching 只表示商品源在跑。"""

    COLLECTING = "collecting"
    CLARIFYING = "clarifying"
    SEARCHING = "searching"
    RANKING = "ranking"
    READY = "ready"
    DEGRADED = "degraded"
    FAILED = "failed"


class TurnPhase(StrEnum):
    """本轮对话动作。前端只在 researching / refiltering 时锁输入。"""

    IDLE = "idle"
    RESPONDING = "responding"
    REFILTERING = "refiltering"
    RESEARCHING = "researching"


class DialogueState(BaseModel):
    """指称状态。态度只写 PreferenceBelief，不在这里存第二份。"""

    model_config = ConfigDict(extra="ignore")

    focus_snapshot_id: str | None = None
    last_act: str | None = None
    mentioned_snapshot_ids: list[str] = Field(default_factory=list)
    pending_ops: list[dict] = Field(default_factory=list)


class MissionConstraints(BaseModel):
    """当前生效的购物约束。country_code 只表示商品市场，不表示配送目的地。"""

    query: str | None = None
    budget_cny: float | None = Field(default=None, gt=0)
    markets: list[str] = Field(default_factory=lambda: list(DEFAULT_MARKETS))
    preference: str = "balanced"
    only_in_stock: bool = False
    excluded_terms: list[str] = Field(default_factory=list)
    merchants: list[str] = Field(default_factory=list)


def next_constraints_version(current: int, before: MissionConstraints, after: MissionConstraints) -> int:
    """约束内容变化才递增。PATCH/undo 由命令层递增；消息合并由 persist 调用本函数。"""
    return current if before == after else current + 1


class ShoppingMission(BaseModel):
    """任务业务聚合根（跨层表示 shopping_missions 表）。"""

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
    turn_phase: TurnPhase = TurnPhase.IDLE
    dialogue: DialogueState = Field(default_factory=DialogueState)
    belief: PreferenceBelief = Field(default_factory=PreferenceBelief)
    goal: ShoppingGoal = Field(default_factory=ShoppingGoal)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
