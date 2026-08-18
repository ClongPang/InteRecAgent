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
    snapshot_ids_for_ranks,
)
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
        act = classify_turn(text)
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
        if act.kind == DialogueActKind.META:
            return {
                "agent_message": "我可以根据品类、预算和市场帮你检索并比较跨境商品。价格来自已校验快照；保修、运费和库存未提供时不会编造。",
                "agent_snapshot_ids": [],
            }
        if not ranked_records:
            return {
                "agent_message": "还没有可引用的候选。请先告诉我品类，例如「降噪耳机」。",
                "agent_snapshot_ids": [],
                "requires_clarification": not bool(mission.constraints.query),
                "clarification_question": CLARIFYING_QUESTION,
            }
        if act.kind == DialogueActKind.COMPARE:
            ranks = act.referent_ranks or [1, 2]
            ids = snapshot_ids_for_ranks(ranked_records, ranks)
            if not 2 <= len(ids) <= 4:
                return {
                    "agent_message": "比较需要 2–4 件当前候选。可以说「帮我比前两个」。",
                    "agent_snapshot_ids": [],
                }
            lines = []
            by_id = {str(item.get("snapshot_id")): item for item in ranked_records}
            for sid in ids:
                item = by_id.get(sid) or {}
                price = (item.get("estimated_cny") or {}).get("amount")
                price_text = f"{price:.0f} 元" if isinstance(price, (int, float)) else "价格待确认"
                lines.append(f"{item.get('title') or sid}：约 {price_text}")
            updated = mission.model_copy(update={"comparison_snapshot_ids": ids})
            return {
                "mission": updated,
                "agent_message": "当前候选对照：\n" + "\n".join(lines),
                "agent_snapshot_ids": ids,
                "comparison_snapshot_ids": ids,
            }
        ranks = act.referent_ranks or [1]
        ids = snapshot_ids_for_ranks(ranked_records, ranks)
        item = next((r for r in ranked_records if str(r.get("snapshot_id")) in ids), ranked_records[0])
        title = item.get("title") or "当前首选"
        if act.kind == DialogueActKind.ASK_ITEM:
            return {
                "agent_message": (
                    f"{title}：快照未提供保修、库存和完整规格，需要到商户页确认。"
                    "我只能依据已记录的价格与市场事实回答。"
                ),
                "agent_snapshot_ids": ids or [str(item.get("snapshot_id") or "")],
            }
        return {
            "agent_message": f"约束没有变化，仍使用当前候选。首选是 {title}。",
            "agent_snapshot_ids": ids,
        }

    return compose_grounded_reply
