"""warnings 跨节点累加（LangGraph reducer）。"""

from __future__ import annotations

from typing import Annotated, NotRequired, TypedDict

from ..application.dto import (
    IntentPatch,
    PreferenceBelief,
    RecommendationDraft,
    RunnerStatus,
    SearchPlan,
    ShoppingMission,
)
from ..application.dto.dialogue import DialogueAct, TurnPlan
from ..application.dto.mission import MissionConstraints
from ..application.dto.probe import Probe
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
    feature_flags: NotRequired[dict[str, object]]

    # 运行中产物
    mission: ShoppingMission
    text: NotRequired[str]
    skip_intent_patch: NotRequired[bool]
    decided_route: NotRequired[str | None]
    decided_act: NotRequired[dict | None]
    dialogue_act: NotRequired[DialogueAct]
    turn_plan: NotRequired[TurnPlan]
    intent_patch: NotRequired[IntentPatch]
    goal_operations: NotRequired[list[dict]]
    goal_revision_committed: NotRequired[bool]
    goal_revision_blocked: NotRequired[bool]
    enabled_item_types: NotRequired[list[str]]
    constraints_before: NotRequired[MissionConstraints]
    belief_before: NotRequired[PreferenceBelief]
    requires_clarification: NotRequired[bool]
    clarification_question: NotRequired[str | None]
    turn_route: NotRequired[str]
    undo_applied: NotRequired[bool]
    events: NotRequired[list[dict]]
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
    agent_next_moves: NotRequired[list[dict]]
    comparison_snapshot_ids: NotRequired[list[str]]
    search_plan: NotRequired[SearchPlan]
    products: NotRequired[list[NormalizedProduct]]
    rates: NotRequired[dict[str, FxSnapshot]]
    fx: NotRequired[list[FxSnapshot]]
    fx_failed_currencies: NotRequired[list[str]]
    failed_markets: NotRequired[list[str]]
    ranked: NotRequired[list[NormalizedProduct]]
    pool: NotRequired[list[NormalizedProduct]]
    goal_coverage: NotRequired[dict | None]
    qualifications: NotRequired[list[dict]]
    answer_plan: NotRequired[dict]
    claim_ledger: NotRequired[dict]
    rendered_claim_ids: NotRequired[list[str]]
    query_trace: NotRequired[list[dict]]
    search_executions: NotRequired[list[dict]]
    product_observations: NotRequired[list[dict]]
    next_action: NotRequired[str]
    normalized_observation_count: NotRequired[int]
    semantic_profiles: NotRequired[dict[str, dict]]
    semantic_profile_proposals: NotRequired[dict[str, dict]]
    semantic_profile_shadow: NotRequired[dict[str, dict]]
    semantic_shadow_stats: NotRequired[dict[str, int]]
    claims_verified: NotRequired[bool]
    response_rendered: NotRequired[bool]
    completion_ok: NotRequired[bool]
    completion_blocked: NotRequired[bool]
    research_proposals: NotRequired[list[dict]]
    recommendation: NotRequired[RecommendationDraft | None]
    probe: NotRequired[Probe]

    # 输出
    status: NotRequired[RunnerStatus]
    candidate_set_id: NotRequired[str]
    recommendation_run_id: NotRequired[str]
    warnings: NotRequired[Annotated[list[str], _accumulate_warnings]]
