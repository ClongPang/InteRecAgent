"""对话分类、路由、缓存复用与 grounded 回复。"""
from __future__ import annotations

from ...application.dto import IntentPatch, RunnerStatus
from ...application.dto.dialogue import DialogueAct, DialogueActKind, NextMove, TurnPlan, TurnRoute
from ...application.errors import ModelUnavailableError
from ...application.ports import ModelBackend
from ...application.services.dialogue import (
    apply_act_effects,
    classify_turn,
    ground_dialogue_act,
    reuse_key_matches,
)
from ...application.services.grounded import compose_talk_reply
from ...application.services.parse_intent import CLARIFYING_QUESTION
from ...application.services.plan import propose_plan
from ...application.services.present import hydrate_candidate_payload
from ...application.services.route import decide_route
from ...application.services.working_set import WorkingSet
from ..state import MissionGraphState


def make_classify_dialogue_act(model_backend: ModelBackend):
    """解析对话行为。约束类话轮可走模型 IntentPatch，提问/排除不把原文当 query。"""

    async def classify_dialogue_act(state: MissionGraphState) -> dict:
        if state.get("skip_intent_patch"):
            raw_act = state.get("decided_act")
            if isinstance(raw_act, dict):
                act = DialogueAct.model_validate(raw_act)
            else:
                act = DialogueAct(kind=DialogueActKind.REFINE, source="command")
            return {
                "dialogue_act": act,
                "intent_patch": act.patch or IntentPatch(),
                "turn_route": state.get("decided_route") or state.get("turn_route"),
            }
        if (
            isinstance(state.get("decided_act"), dict)
            and state.get("decided_route")
            and state["decided_act"].get("kind") not in {DialogueActKind.UNKNOWN.value, None}
        ):
            act = DialogueAct.model_validate(state["decided_act"])
            return {
                "dialogue_act": act,
                "intent_patch": act.patch or IntentPatch(),
                "turn_route": state["decided_route"],
            }
        text = state.get("text") or ""
        current_query = state["mission"].constraints.query
        context = dict(state.get("turn_context") or _turn_context(state))
        working = WorkingSet.from_cache(
            state.get("cache_payload"),
            mentioned_ids=list(getattr(state["mission"].dialogue, "mentioned_snapshot_ids", None) or []),
            comparison_ids=list(state["mission"].comparison_snapshot_ids or []),
        )
        ranked = list(working.display)
        context["ranked"] = ranked
        context["pool"] = list(working.bind_records)
        plan = propose_plan(text, current_query=current_query, world=working.world())
        # LLM 优先：配置了模型时由 parse_turn 直接给出行为+patch（含开放式 soft_prefs），
        # 确定性 classify_turn 仅作 fallback。这里已越过命令层预判短路，
        # 故重算路由（decided_route=None 交给 route_turn 依 LLM 行为推断）。
        if model_backend.is_configured():
            try:
                act = await model_backend.parse_turn(
                    text, current_query=current_query, context=context
                )
                act = ground_dialogue_act(act, text, current_query=current_query, ranked=list(working.bind_records))
                return {
                    "dialogue_act": act,
                    "intent_patch": act.patch or IntentPatch(),
                    "turn_plan": _plan_with_primary(plan, act),
                    "decided_route": None,
                }
            except ModelUnavailableError:
                pass
        act = classify_turn(text, current_query=current_query, context=context)
        act = ground_dialogue_act(act, text, current_query=current_query, ranked=list(working.bind_records))
        return {
            "dialogue_act": act,
            "intent_patch": act.patch or IntentPatch(),
            "turn_plan": _plan_with_primary(plan, act),
        }

    return classify_dialogue_act


def _plan_with_primary(plan: TurnPlan, act: DialogueAct) -> TurnPlan:
    rest = [item for item in plan.ops if item.kind != act.kind]
    leftover = [item for item in plan.leftover if item.kind != act.kind]
    return TurnPlan(ops=[act] + rest, leftover=leftover, lead=act)


async def apply_turn_effects(state: MissionGraphState) -> dict:
    """把已分类行为的信念副作用落到任务上（价格态度 / 否定聚焦 / 不支持维度）。

    控制反转后由图承担（原属命令层 DialoguePolicy）；与 DialoguePolicy 共用
    apply_act_effects，保证确定性与 LLM 两条路径信念演化一致。"""
    mission = state["mission"]
    act = state.get("dialogue_act")
    if act is None:
        return {}
    belief, dialogue = apply_act_effects(
        mission.belief, mission.dialogue, act, cache_payload=state.get("cache_payload")
    )
    return {"mission": mission.model_copy(update={"belief": belief, "dialogue": dialogue})}


def _turn_context(state: MissionGraphState) -> dict:
    from ...application.services.nlu import build_turn_context

    return build_turn_context(
        state.get("events") or [],
        state.get("mission"),
        state.get("cache_payload"),
    )


async def route_turn(state: MissionGraphState) -> dict:
    act = state.get("dialogue_act") or DialogueAct(kind=DialogueActKind.REFINE)
    mission = state["mission"]
    payload = state.get("cache_payload")
    has_cache = bool(payload and payload.get("ranked"))
    reuse_matches = reuse_key_matches(mission.constraints, (payload or {}).get("reuse_key"))
    before = state.get("constraints_before") or mission.constraints
    route = decide_route(
        kind=act.kind,
        has_query=bool(mission.constraints.query),
        has_cache=has_cache,
        reuse_matches=reuse_matches,
        skip_intent_patch=bool(state.get("skip_intent_patch")),
        constraints_changed=before != mission.constraints,
        merchants=list(mission.constraints.merchants),
        ranked=list((payload or {}).get("ranked") or []),
        pool=list((payload or {}).get("pool") or (payload or {}).get("ranked") or []),
    )
    if state.get("decided_route"):
        return {
            "turn_route": state["decided_route"],
            "requires_clarification": state["decided_route"] == TurnRoute.CLARIFY.value,
        }
    # 不支持维度的态度（如「更轻/太重」但快照无重量字段）：已在 apply_turn_effects 记为
    # unsupported，改答复解释而非空排序（rerank 无维度支撑等于原地打转）。
    if act.kind == DialogueActKind.STANCE and act.stance == "want_lighter":
        return {"turn_route": TurnRoute.TALK.value, "requires_clarification": False}
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
        working = WorkingSet.from_cache(
            payload,
            mentioned_ids=list(mission.dialogue.mentioned_snapshot_ids or []),
            comparison_ids=list(mission.comparison_snapshot_ids or []),
        )
        plan = state.get("turn_plan")
        compare_ids = set(mission.comparison_snapshot_ids or [])
        reply = compose_talk_reply(
            act=act,
            text=state.get("text") or "",
            ranked=ranked_records,
            constraints=mission.constraints,
            focus_snapshot_id=getattr(mission.dialogue, "focus_snapshot_id", None),
            belief=mission.belief,
            comparison_records=[
                item for item in working.bind_records if item.get("snapshot_id") in compare_ids
            ],
            working=working,
            plan=plan,
        )
        moves = list(reply.next_moves)
        leftover = list(getattr(plan, "leftover", None) or [])
        if any(item.kind == DialogueActKind.COMPARE for item in leftover):
            if not any(move.text == "帮我比前两个" for move in moves):
                moves.append(NextMove(label="对比前两件", text="帮我比前两个"))
        dialogue = mission.dialogue.model_copy(
            update={"pending_ops": [item.model_dump(mode="json") for item in leftover]}
        )
        result = {
            "agent_message": reply.text,
            "agent_snapshot_ids": reply.snapshot_ids,
            "agent_citations": reply.citations,
            "agent_act": act.kind.value,
            "agent_topic": act.topic.value if act.topic else None,
            "agent_next_moves": [item.model_dump(mode="json") for item in moves],
            "mission": mission.model_copy(update={"dialogue": dialogue}),
        }
        if reply.requires_clarification:
            result["requires_clarification"] = True
            result["clarification_question"] = reply.clarification_question or CLARIFYING_QUESTION
        if reply.comparison_snapshot_ids:
            result["mission"] = mission.model_copy(
                update={
                    "dialogue": dialogue,
                    "comparison_snapshot_ids": reply.comparison_snapshot_ids,
                }
            )
            result["comparison_snapshot_ids"] = reply.comparison_snapshot_ids
        return result

    return compose_grounded_reply
