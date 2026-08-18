"""对话分类、路由、缓存复用与 grounded 回复。"""
from __future__ import annotations

from ...application.dto import IntentPatch, RunnerStatus
from ...application.dto.dialogue import DialogueAct, DialogueActKind, TurnRoute
from ...application.errors import ModelUnavailableError
from ...application.ports import ModelBackend
from ...application.services.dialogue import (
    classify_turn,
    plan_route,
    reuse_key_matches,
)
from ...application.services.grounded import compose_talk_reply
from ...application.services.parse_intent import CLARIFYING_QUESTION
from ...application.services.present import hydrate_candidate_payload
from ..state import MissionGraphState


def make_classify_dialogue_act(model_backend: ModelBackend):
    """解析对话行为。约束类话轮可走模型 IntentPatch，提问/排除不把原文当 query。"""

    async def classify_dialogue_act(state: MissionGraphState) -> dict:
        if state.get("skip_intent_patch"):
            act = DialogueAct(kind=DialogueActKind.REFINE, source="command")
            return {"dialogue_act": act, "intent_patch": IntentPatch()}
        text = state.get("text") or ""
        current_query = state["mission"].constraints.query
        act = classify_turn(text, current_query=current_query)
        if act.kind == DialogueActKind.REFINE and model_backend.is_configured():
            try:
                patch = await model_backend.parse_intent(text)
                act = act.model_copy(update={"patch": patch, "source": "model"})
            except ModelUnavailableError:
                pass
        return {"dialogue_act": act, "intent_patch": act.patch or IntentPatch()}

    return classify_dialogue_act


async def route_turn(state: MissionGraphState) -> dict:
    act = state.get("dialogue_act") or DialogueAct(kind=DialogueActKind.REFINE)
    mission = state["mission"]
    payload = state.get("cache_payload")
    has_cache = bool(payload and payload.get("ranked"))
    reuse_matches = reuse_key_matches(mission.constraints, (payload or {}).get("reuse_key"))
    before = state.get("constraints_before") or mission.constraints
    route = plan_route(
        kind=act.kind,
        has_query=bool(mission.constraints.query),
        has_cache=has_cache,
        reuse_matches=reuse_matches,
        skip_intent_patch=bool(state.get("skip_intent_patch")),
        constraints_changed=before != mission.constraints,
    )
    if state.get("requires_clarification") or route == TurnRoute.CLARIFY:
        if not mission.constraints.query:
            return {
                "turn_route": TurnRoute.CLARIFY.value,
                "requires_clarification": True,
                "clarification_question": state.get("clarification_question") or CLARIFYING_QUESTION,
                "status": RunnerStatus.COMPLETED,
            }
    return {"turn_route": route.value, "requires_clarification": False}


def make_load_cached_candidates():
    async def load_cached_candidates(state: MissionGraphState) -> dict:
        products, snapshot_map, rates, fx_ids = hydrate_candidate_payload(state.get("cache_payload"))
        return {
            "products": products,
            "snapshot_map": snapshot_map,
            "rates": rates,
            "fx": list(rates.values()),
            "cached_fx_snapshot_ids": fx_ids,
            "reuse_snapshots": True,
        }

    return load_cached_candidates


def make_compose_grounded_reply():
    """基于当前候选快照回答，不访问商品源。"""

    async def compose_grounded_reply(state: MissionGraphState) -> dict:
        act = state.get("dialogue_act") or DialogueAct(kind=DialogueActKind.META)
        payload = state.get("cache_payload") or {}
        ranked_records = list(payload.get("ranked") or [])
        mission = state["mission"]
        reply = compose_talk_reply(
            act=act,
            text=state.get("text") or "",
            ranked=ranked_records,
            constraints=mission.constraints,
            focus_snapshot_id=getattr(mission.dialogue, "focus_snapshot_id", None),
        )
        result = {
            "agent_message": reply.text,
            "agent_snapshot_ids": reply.snapshot_ids,
            "agent_citations": reply.citations,
            "agent_act": act.kind.value,
            "agent_topic": act.topic.value if act.topic else None,
        }
        if reply.requires_clarification:
            result["requires_clarification"] = True
            result["clarification_question"] = reply.clarification_question or CLARIFYING_QUESTION
        if reply.comparison_snapshot_ids:
            result["mission"] = mission.model_copy(
                update={"comparison_snapshot_ids": reply.comparison_snapshot_ids}
            )
            result["comparison_snapshot_ids"] = reply.comparison_snapshot_ids
        return result

    return compose_grounded_reply
