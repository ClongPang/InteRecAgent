"""对话政策：把聊天与命令收成同一套 TurnInput，再决定是否调度子图。"""
from __future__ import annotations

from pydantic import BaseModel, Field

from ..dto.dialogue import DialogueAct, DialogueActKind, TurnCommand, TurnRoute
from ..dto.mission import DialogueState, MissionConstraints, ShoppingMission, TurnPhase
from ..dto.runner import IntentPatch
from .dialogue import apply_stance_budget, classify_turn, preview_merged_constraints, preview_turn
from .parse_intent import parse_intent


def supports_audio_preference(query: str | None) -> bool:
    text = (query or "").lower()
    return any(token in text for token in ("耳机", "降噪", "headphone", "earbuds"))


def sanitize_constraints(
    query: str | None, before: MissionConstraints, after: MissionConstraints
) -> tuple[MissionConstraints, list[str], list[str]]:
    """能力不足的约束不写入。库存字段当前不可用；续航/降噪需品类支持。"""
    warnings: list[str] = []
    replies: list[str] = []
    preference = after.preference
    only_in_stock = after.only_in_stock
    effective_query = after.query or query
    if only_in_stock:
        only_in_stock = False
        warnings.append("当前数据无法校验库存，仅看有货未生效")
        replies.append("快照没有可用库存事实，我不能按「仅看有货」过滤，仍保留全部候选。")
    if preference in {"battery", "noise"} and not supports_audio_preference(effective_query):
        preference = before.preference if before.preference not in {"battery", "noise"} else "balanced"
        label = "优先续航" if after.preference == "battery" else "优先降噪"
        warnings.append(f"当前商品数据无法按「{after.preference}」排序")
        replies.append(f"当前候选没有{label}所需的规格字段，我不会假装已按这个依据排序。")
    sanitized = after.model_copy(update={"preference": preference, "only_in_stock": only_in_stock})
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


class DialoguePolicy:
    """Application 层大脑。LangGraph 只在 research/refilter 时被调度。"""

    def decide(
        self,
        *,
        mission: ShoppingMission,
        turn: TurnInput,
        has_cache: bool,
        cache_reuse_key: dict | None,
    ) -> TurnDecision:
        dialogue = mission.dialogue.model_copy()
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
            )

        text = (turn.text or "").strip()
        act = classify_turn(text, current_query=mission.constraints.query)
        act = apply_stance_budget(act, mission.constraints)
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
            )

        merged = preview_merged_constraints(mission.constraints, act)
        merged, warnings, replies = sanitize_constraints(mission.constraints.query, mission.constraints, merged)
        if act.patch is not None:
            act = act.model_copy(
                update={
                    "patch": act.patch.model_copy(
                        update={
                            "preference": merged.preference if merged.preference != mission.constraints.preference else act.patch.preference,
                            "only_in_stock": None,
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
            )
        if replies and merged == mission.constraints:
            return TurnDecision(
                act=act,
                route=TurnRoute.TALK,
                phase=TurnPhase.IDLE,
                constraints=mission.constraints,
                dialogue=dialogue,
                dispatch=False,
                agent_message=" ".join(replies),
                warnings=warnings,
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
        )


def _stance_reply(stance: str | None) -> str:
    if stance == "too_expensive":
        return "可以说一个更明确的人民币预算，例如「预算 2000 元」，我会按当前候选重筛。"
    if stance == "want_cheaper":
        return "可以说目标预算，例如「预算 1500 元」。我不会把「再便宜一点」当成新品类去重搜。"
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
