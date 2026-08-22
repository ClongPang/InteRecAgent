"""话轮世界动作。阶段 0 只落地 undo_constraints：识别与回滚共用这一执行器。

按钮 / 词表短路 / 模型标 undo，最终都调用这里，不得再各写一套 before 扫描。
"""
from __future__ import annotations

from ..dto.dialogue import DialogueAct, DialogueActKind, TurnRoute
from ..dto.mission import DialogueState, MissionConstraints, ShoppingMission, TurnPhase
from .route import preview_turn

NOTHING_TO_UNDO_MESSAGE = "没有可撤销的约束变更。"


def find_restorable_constraints(events: list[dict]) -> MissionConstraints | None:
    """最近一条带 query 的 constraints.updated.before。跳过 undo 事件本身。"""
    for event in reversed(events or []):
        if event.get("event_type") != "constraints.updated":
            continue
        payload = event.get("payload") or {}
        raw = payload.get("before")
        if not isinstance(raw, dict):
            continue
        before = MissionConstraints(**raw)
        if not (before.query or "").strip():
            continue
        return before
    return None


def apply_undo_constraints(mission: ShoppingMission, restored: MissionConstraints) -> ShoppingMission:
    dialogue = mission.dialogue if isinstance(mission.dialogue, DialogueState) else DialogueState()
    return mission.model_copy(
        update={
            "constraints": restored,
            "dialogue": dialogue.model_copy(update={"last_act": DialogueActKind.UNDO.value}),
        }
    )


def route_after_undo(
    *,
    current: MissionConstraints,
    restored: MissionConstraints,
    has_cache: bool,
    cache_reuse_key: dict | None,
) -> tuple[TurnRoute, TurnPhase]:
    route, phase = preview_turn(
        act=DialogueAct(kind=DialogueActKind.REFINE, source="command"),
        constraints=restored,
        has_cache=has_cache,
        cache_reuse_key=cache_reuse_key,
        skip_intent_patch=True,
    )
    if current != restored and phase == TurnPhase.RESPONDING:
        return TurnRoute.REFILTER, TurnPhase.REFILTERING
    return route, phase


def ledger_constraint_event(
    *,
    undo_applied: bool,
    run_id: str,
    before: MissionConstraints,
    after: MissionConstraints,
    version: int,
) -> tuple[str, dict]:
    """persist 写账本。undo 只记 restored，避免再插一条 updated 把下一笔撤销拧成「撤撤销」。"""
    if undo_applied:
        return "constraints.undo", {
            "run_id": run_id,
            "restored": after.model_dump(mode="json"),
            "constraints_version": version,
        }
    return "constraints.updated", {
        "run_id": run_id,
        "before": before.model_dump(mode="json"),
        "after": after.model_dump(mode="json"),
        "constraints_version": version,
    }
