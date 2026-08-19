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
from ..application.dto.dialogue import DialogueAct
from ..application.dto.mission import MissionConstraints
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
    decided_route: NotRequired[str | None]
    decided_act: NotRequired[dict | None]
    dialogue_act: NotRequired[DialogueAct]
    intent_patch: NotRequired[IntentPatch]
    constraints_before: NotRequired[MissionConstraints]
    requires_clarification: NotRequired[bool]
    clarification_question: NotRequired[str | None]
    turn_route: NotRequired[str]
    cache_payload: NotRequired[dict | None]
    turn_context: NotRequired[dict]
    snapshot_map: NotRequired[dict[str, str]]
    reuse_snapshots: NotRequired[bool]
    cached_fx_snapshot_ids: NotRequired[list[str]]
    agent_message: NotRequired[str]
    agent_snapshot_ids: NotRequired[list[str]]
    agent_citations: NotRequired[list[dict]]
    agent_act: NotRequired[str]
    agent_topic: NotRequired[str | None]
    comparison_snapshot_ids: NotRequired[list[str]]
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
