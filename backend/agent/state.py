"""warnings 跨节点累加（LangGraph reducer）。"""
from __future__ import annotations

from typing import Annotated, NotRequired, TypedDict

from ..application.dto import (
    IntentPatch,
    RecommendationDraft,
    RunnerStatus,
    SearchPlan,
    ShoppingMission,
)
from ..domain.models import FxSnapshot, NormalizedProduct


def _accumulate_warnings(left, right) -> list[str]:
    
    if left is None:
        return list(right)
    return list(left) + list(right)


class MissionGraphState(TypedDict, total=False):
    """一次 Agent 运行的短生命周期图状态。业务事实由 ShoppingMission 与快照持久化承担，
    LangGraph checkpoint 只记录图执行位置（不代替业务存储）。"""

    # 输入（由 RunDispatcher 提供）
    owner_id: str
    mission_id: str
    run_id: str
    run_version: int

    # 运行中产物
    mission: ShoppingMission
    text: NotRequired[str]
    skip_intent_patch: NotRequired[bool]
    intent_patch: NotRequired[IntentPatch]
    requires_clarification: NotRequired[bool]
    clarification_question: NotRequired[str | None]
    search_plan: NotRequired[SearchPlan]
    products: NotRequired[list[NormalizedProduct]]
    rates: NotRequired[dict[str, FxSnapshot]]
    fx: NotRequired[list[FxSnapshot]]
    fx_failed_currencies: NotRequired[list[str]]
    failed_markets: NotRequired[list[str]]
    ranked: NotRequired[list[NormalizedProduct]]
    recommendation: NotRequired[RecommendationDraft | None]

    # 输出
    status: NotRequired[RunnerStatus]
    candidate_set_id: NotRequired[str]
    recommendation_run_id: NotRequired[str]
    warnings: NotRequired[Annotated[list[str], _accumulate_warnings]]
