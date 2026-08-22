"""把已识别的控制动作绑到世界执行器。阶段 0 只处理 undo。"""
from __future__ import annotations

from ...application.dto.dialogue import DialogueActKind, TurnRoute
from ...application.services.turn_actions import (
    NOTHING_TO_UNDO_MESSAGE,
    apply_undo_constraints,
    find_restorable_constraints,
    route_after_undo,
)
from ..state import MissionGraphState


async def bind_turn_actions(state: MissionGraphState) -> dict:
    """kind=undo 时调用与按钮同一套回滚；无可撤事件则显式 talk，不概述第一件。"""
    act = state.get("dialogue_act")
    ops = list(getattr(state.get("turn_plan"), "ops", None) or [])
    has_undo = (act is not None and act.kind == DialogueActKind.UNDO) or any(
        item.kind == DialogueActKind.UNDO for item in ops
    )
    if not has_undo:
        return {}
    mission = state["mission"]
    restored = find_restorable_constraints(list(state.get("events") or []))
    if restored is None:
        return {
            "decided_route": TurnRoute.TALK.value,
            "turn_route": TurnRoute.TALK.value,
            "agent_message": NOTHING_TO_UNDO_MESSAGE,
            "agent_act": DialogueActKind.UNDO.value,
            "requires_clarification": False,
        }
    payload = state.get("cache_payload") or {}
    route, _phase = route_after_undo(
        current=mission.constraints,
        restored=restored,
        has_cache=bool(payload.get("ranked")),
        cache_reuse_key=payload.get("reuse_key"),
    )
    return {
        "mission": apply_undo_constraints(mission, restored),
        "skip_intent_patch": True,
        "undo_applied": True,
        "decided_route": route.value,
        "turn_route": route.value,
        "constraints_before": mission.constraints,
        "requires_clarification": False,
    }
