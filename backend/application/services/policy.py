"""对话政策：把聊天与命令收成同一套 TurnInput，再决定是否调度子图。"""
from __future__ import annotations

from pydantic import BaseModel, Field

from ..dto.belief import PreferenceBelief
from ..dto.dialogue import DialogueAct, DialogueActKind, TurnCommand, TurnRoute
from ..dto.mission import DialogueState, MissionConstraints, ShoppingMission, TurnPhase
from ..dto.runner import IntentPatch
from .nlu import preview_merged_constraints, snapshot_ids_for_ranks
from .parse_intent import parse_intent
from .route import preview_turn


def supports_audio_preference(query: str | None) -> bool:
    text = (query or "").lower()
    return any(token in text for token in ("耳机", "headphone", "earbuds"))


def apply_act_effects(
    belief: PreferenceBelief,
    dialogue: DialogueState,
    act: DialogueAct,
    *,
    cache_payload: dict | None = None,
) -> tuple[PreferenceBelief, DialogueState]:
    """把一次话轮行为的信念副作用焊死在此（价格态度 / 否定聚焦 / 不支持维度）。

    单一事实源：DialoguePolicy（确定性参照）与图节点 apply_turn_effects（运行时权威）
    都调用它，保证「命令层预判」与「LLM 自主编排」两条路径的信念演化不漂移。"""
    if act.kind == DialogueActKind.STANCE and act.stance in {"too_expensive", "want_cheaper"}:
        belief = belief.mark_price_stance(act.stance)
    if act.kind == DialogueActKind.REJECT:
        focus = dialogue.focus_snapshot_id
        if not focus and cache_payload:
            ids = snapshot_ids_for_ranks(
                list(cache_payload.get("ranked") or []), act.referent_ranks or [1]
            )
            focus = ids[0] if ids else None
        if focus:
            belief = belief.reject(focus)
    if act.stance == "want_lighter":
        belief = belief.mark_unsupported("weight", "lower")
    dialogue = dialogue.model_copy(update={"last_act": act.kind.value})
    return belief, dialogue


def sanitize_constraints(
    query: str | None, before: MissionConstraints, after: MissionConstraints
) -> tuple[MissionConstraints, list[str], list[str]]:
    """续航/降噪无规格时不写入排序偏好。库存改为候选集上按事实过滤。"""
    warnings: list[str] = []
    replies: list[str] = []
    preference = after.preference
    effective_query = after.query or query
    if preference in {"battery", "noise"} and not supports_audio_preference(effective_query):
        preference = before.preference if before.preference not in {"battery", "noise"} else "balanced"
        label = "优先续航" if after.preference == "battery" else "优先降噪"
        warnings.append(f"当前商品数据无法按「{after.preference}」排序")
        replies.append(f"当前候选没有{label}所需的规格字段，我不会假装已按这个依据排序。")
    sanitized = after.model_copy(update={"preference": preference})
    return sanitized, warnings, replies


class TurnInput(BaseModel):
    command: TurnCommand = TurnCommand.MESSAGE
    source: str = "chat"
    text: str | None = None
    constraints: MissionConstraints | None = None
    focus_snapshot_id: str | None = None


class TurnDecision(BaseModel):
    act: DialogueAct
    route: TurnRoute
    phase: TurnPhase
    constraints: MissionConstraints
    dialogue: DialogueState
    dispatch: bool = True
    undo: bool = False
    apply_constraints: bool = False
    agent_message: str | None = None
    warnings: list[str] = Field(default_factory=list)
    belief: PreferenceBelief = Field(default_factory=PreferenceBelief)


class DialoguePolicy:
    """结构化约束编辑（PATCH）的确定性决策。

    控制反转（Phase 3）后，自由文本话轮的分类/路由/信念副作用由 Agent 图承担
    （classify_dialogue_act → apply_turn_effects → merge_mission_state → route_turn），
    命令层不再预判。本类只服务 update_constraints 的结构化 PATCH：它没有自由文本可分类，
    天然确定性，无需 LLM。约束级护栏 sanitize_constraints 与图 merge 节点共用，不漂移。"""

    def decide(
        self,
        *,
        mission: ShoppingMission,
        turn: TurnInput,
        has_cache: bool,
        cache_reuse_key: dict | None,
        cache_payload: dict | None = None,
        turn_context: dict | None = None,
    ) -> TurnDecision:
        if turn.command != TurnCommand.PATCH:
            raise ValueError(
                f"DialoguePolicy 仅处理结构化 PATCH；{turn.command} 由 Agent 图负责"
            )
        del cache_payload, turn_context
        dialogue = mission.dialogue.model_copy()
        belief = mission.belief.model_copy()
        desired = turn.constraints or mission.constraints
        sanitized, warnings, replies = sanitize_constraints(
            mission.constraints.query, mission.constraints, desired
        )
        act = DialogueAct(kind=DialogueActKind.REFINE, source=turn.source, patch=IntentPatch())
        dialogue.last_act = act.kind.value
        if sanitized == mission.constraints:
            return TurnDecision(
                act=act,
                route=TurnRoute.TALK,
                phase=TurnPhase.IDLE,
                constraints=mission.constraints,
                dialogue=dialogue,
                dispatch=False,
                agent_message=" ".join(replies) or "这个条件当前无法执行，约束没有改动。",
                warnings=warnings,
                belief=belief,
            )
        _route, phase = preview_turn(
            act=act,
            constraints=sanitized,
            has_cache=has_cache,
            cache_reuse_key=cache_reuse_key,
            skip_intent_patch=True,
        )
        if phase == TurnPhase.RESPONDING:
            phase = TurnPhase.REFILTERING
            _route = TurnRoute.REFILTER
        return TurnDecision(
            act=act,
            route=_route,
            phase=phase,
            constraints=sanitized,
            dialogue=dialogue,
            dispatch=True,
            apply_constraints=True,
            warnings=warnings,
            agent_message=" ".join(replies) or None,
            belief=belief,
        )


def command_patch_from_text(text: str, current: MissionConstraints) -> MissionConstraints:
    """测试辅助：把一句话当成 PATCH 预览。"""
    patch = parse_intent(text, current_query=current.query)
    return preview_merged_constraints(
        current,
        DialogueAct(kind=DialogueActKind.REFINE, patch=patch),
    )
