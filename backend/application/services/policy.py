"""对话政策：把聊天与命令收成同一套 TurnInput，再决定是否调度子图。"""
from __future__ import annotations

from pydantic import BaseModel, Field

from ..dto.belief import PreferenceBelief
from ..dto.dialogue import DialogueAct, DialogueActKind, TurnCommand, TurnRoute
from ..dto.mission import DialogueState, MissionConstraints, ShoppingMission, TurnPhase
from ..dto.runner import IntentPatch
from .nlu import classify_turn, preview_merged_constraints, snapshot_ids_for_ranks
from .parse_intent import parse_intent
from .route import preview_turn


def supports_audio_preference(query: str | None) -> bool:
    text = (query or "").lower()
    return any(token in text for token in ("耳机", "headphone", "earbuds"))


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
    """Application 层唯一话轮决策。图只执行已决定的 route。"""

    def decide(
        self,
        *,
        mission: ShoppingMission,
        turn: TurnInput,
        has_cache: bool,
        cache_reuse_key: dict | None,
        cache_payload: dict | None = None,
    ) -> TurnDecision:
        dialogue = mission.dialogue.model_copy()
        belief = mission.belief.model_copy()
        if turn.focus_snapshot_id:
            dialogue.focus_snapshot_id = turn.focus_snapshot_id

        if turn.command == TurnCommand.UNDO:
            dialogue.last_act = DialogueActKind.UNDO.value
            return TurnDecision(
                act=DialogueAct(kind=DialogueActKind.UNDO, source=turn.source),
                route=TurnRoute.REFILTER,
                phase=TurnPhase.REFILTERING,
                constraints=mission.constraints,
                dialogue=dialogue,
                undo=True,
                dispatch=True,
                belief=belief,
            )

        if turn.command == TurnCommand.PATCH:
            desired = turn.constraints or mission.constraints
            sanitized, warnings, replies = sanitize_constraints(
                mission.constraints.query, mission.constraints, desired
            )
            act = DialogueAct(kind=DialogueActKind.REFINE, source=turn.source, patch=IntentPatch())
            if sanitized == mission.constraints:
                dialogue.last_act = act.kind.value
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
            if sanitized != mission.constraints and phase == TurnPhase.RESPONDING:
                phase = TurnPhase.REFILTERING
                _route = TurnRoute.REFILTER
            dialogue.last_act = act.kind.value
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

        text = (turn.text or "").strip()
        act = classify_turn(text, current_query=mission.constraints.query)
        if act.kind == DialogueActKind.STANCE and act.stance in {"too_expensive", "want_cheaper"}:
            belief = belief.mark_price_stance(act.stance)
        if act.kind == DialogueActKind.REJECT:
            focus = dialogue.focus_snapshot_id
            if not focus and cache_payload:
                ids = snapshot_ids_for_ranks(list(cache_payload.get("ranked") or []), act.referent_ranks or [1])
                focus = ids[0] if ids else None
            if focus:
                belief = belief.reject(focus)
        if act.stance == "want_lighter":
            belief = belief.mark_unsupported("weight", "lower")
        dialogue.last_act = act.kind.value
        dialogue.stance = act.stance or dialogue.stance
        if act.kind == DialogueActKind.UNDO:
            return TurnDecision(
                act=act,
                route=TurnRoute.REFILTER,
                phase=TurnPhase.REFILTERING,
                constraints=mission.constraints,
                dialogue=dialogue,
                undo=True,
                dispatch=True,
                belief=belief,
            )

        merged = preview_merged_constraints(mission.constraints, act)
        merged, warnings, replies = sanitize_constraints(mission.constraints.query, mission.constraints, merged)
        if act.patch is not None:
            act = act.model_copy(
                update={
                    "patch": act.patch.model_copy(
                        update={
                            "preference": merged.preference if merged.preference != mission.constraints.preference else act.patch.preference,
                            "only_in_stock": act.patch.only_in_stock,
                            "query": act.patch.query,
                        }
                    )
                }
            )
        route, phase = preview_turn(
            act=act,
            constraints=mission.constraints,
            has_cache=has_cache,
            cache_reuse_key=cache_reuse_key,
        )
        if merged != mission.constraints and route == TurnRoute.TALK:
            route = TurnRoute.REFILTER
            phase = TurnPhase.REFILTERING
        if act.kind == DialogueActKind.STANCE and merged == mission.constraints:
            if act.stance == "want_lighter":
                return TurnDecision(
                    act=act,
                    route=TurnRoute.TALK,
                    phase=TurnPhase.IDLE,
                    constraints=mission.constraints,
                    dialogue=dialogue,
                    dispatch=False,
                    agent_message=_stance_reply(act.stance),
                    warnings=warnings,
                    belief=belief,
                )
            if not mission.constraints.query:
                return TurnDecision(
                    act=act,
                    route=TurnRoute.CLARIFY,
                    phase=TurnPhase.RESPONDING,
                    constraints=mission.constraints,
                    dialogue=dialogue,
                    dispatch=True,
                    agent_message=_stance_reply(act.stance),
                    warnings=warnings,
                    belief=belief,
                )
            if has_cache:
                return TurnDecision(
                    act=act,
                    route=TurnRoute.RERANK,
                    phase=TurnPhase.REFILTERING,
                    constraints=mission.constraints,
                    dialogue=dialogue,
                    dispatch=True,
                    apply_constraints=False,
                    agent_message=_stance_reply(act.stance),
                    warnings=warnings,
                    belief=belief,
                )
            return TurnDecision(
                act=act,
                route=TurnRoute.TALK,
                phase=TurnPhase.IDLE,
                constraints=mission.constraints,
                dialogue=dialogue,
                dispatch=False,
                agent_message=_stance_reply(act.stance) or " ".join(replies),
                warnings=warnings,
                belief=belief,
            )
        if replies and merged == mission.constraints and act.kind != DialogueActKind.REJECT:
            return TurnDecision(
                act=act,
                route=TurnRoute.TALK,
                phase=TurnPhase.IDLE,
                constraints=mission.constraints,
                dialogue=dialogue,
                dispatch=False,
                agent_message=" ".join(replies),
                warnings=warnings,
                belief=belief,
            )
        return TurnDecision(
            act=act,
            route=route,
            phase=phase,
            constraints=merged,
            dialogue=dialogue,
            dispatch=True,
            apply_constraints=merged != mission.constraints,
            warnings=warnings,
            agent_message=" ".join(replies) or None,
            belief=belief,
        )


def _stance_reply(stance: str | None) -> str:
    if stance == "too_expensive":
        return "已记下「太贵了」，会提高价格权重重排，但没有改硬预算。可以说具体上限，例如「预算 2000 元」。"
    if stance == "want_cheaper":
        return "已记下「再便宜一点」，会按价格敏感重排。需要硬上限时请说「预算 1500 元」。"
    if stance == "want_lighter":
        return "快照没有重量字段，我不能按「更轻」排序或过滤，也不会编造规格。"
    return "我记下了这个态度，但还不能据此改检索。"


def command_patch_from_text(text: str, current: MissionConstraints) -> MissionConstraints:
    """测试辅助：把一句话当成 PATCH 预览。"""
    patch = parse_intent(text, current_query=current.query)
    return preview_merged_constraints(
        current,
        DialogueAct(kind=DialogueActKind.REFINE, patch=patch),
    )
