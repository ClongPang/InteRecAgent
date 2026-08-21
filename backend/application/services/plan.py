"""从一句抽出 TurnPlan。并列运算可共存；primary 兼容旧路由。"""
from __future__ import annotations

from ..dto.dialogue import DialogueAct, DialogueActKind, TurnPlan
from ..dto.runner import IntentPatch
from .frames import collect_acts
from .parse_intent import CLARIFYING_QUESTION, parse_intent
from .world import World

_TALK = {
    DialogueActKind.ASK_ITEM,
    DialogueActKind.ASK_SET,
    DialogueActKind.COMPARE,
    DialogueActKind.META,
}
_ROUTE_PRIORITY = (
    DialogueActKind.UNDO,
    DialogueActKind.META,
    DialogueActKind.REJECT,
    DialogueActKind.STANCE,
    DialogueActKind.REFINE,
    DialogueActKind.ASK_SET,
    DialogueActKind.COMPARE,
    DialogueActKind.ASK_ITEM,
)


def propose_plan(
    text: str,
    *,
    current_query: str | None = None,
    world: World | None = None,
) -> TurnPlan:
    raw = (text or "").strip()
    if not raw:
        return TurnPlan(
            ops=[
                DialogueAct(
                    kind=DialogueActKind.UNKNOWN,
                    patch=IntentPatch(
                        requires_clarification=True,
                        clarification_question=CLARIFYING_QUESTION,
                    ),
                )
            ]
        )
    acts = collect_acts(raw, current_query=current_query, world=world)
    if not acts:
        patch = parse_intent(raw, current_query=current_query)
        kind = DialogueActKind.UNKNOWN if patch.requires_clarification else DialogueActKind.REFINE
        acts = [DialogueAct(kind=kind, patch=patch)]
    primary = _primary(acts)
    leftover = [item for item in acts if item is not primary]
    if primary.kind in _TALK:
        leftover = [item for item in leftover if item.kind not in _TALK]
    return TurnPlan(ops=_ordered(acts), leftover=leftover, lead=primary)


def _primary(acts: list[DialogueAct]) -> DialogueAct:
    by_kind = {item.kind: item for item in acts}
    for kind in _ROUTE_PRIORITY:
        if kind in by_kind:
            return by_kind[kind]
    return acts[0]


def _ordered(acts: list[DialogueAct]) -> list[DialogueAct]:
    talk = [item for item in acts if item.kind in _TALK]
    rest = [item for item in acts if item.kind not in _TALK]
    if talk:
        return talk + rest
    return rest or acts
