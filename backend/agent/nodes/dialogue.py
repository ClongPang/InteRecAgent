"""对话分类、路由、缓存复用与 grounded 回复。"""
from __future__ import annotations

from ...application.dto import IntentPatch
from ...application.dto.dialogue import DialogueAct, DialogueActKind, NextMove
from ...application.ports import ModelBackend
from ...application.services.decide_oral import decide_oral_turn
from ...application.services.dialogue import apply_act_effects
from ...application.services.execute_ops import finish_world_route
from ...application.services.grounded import compose_talk_reply
from ...application.services.turn_actions import NOTHING_TO_UNDO_MESSAGE
from ...application.services.parse_intent import CLARIFYING_QUESTION
from ...application.services.present import hydrate_candidate_payload
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
        plan = await decide_oral_turn(
            text,
            current_query=current_query,
            context=context,
            ranked=list(working.bind_records),
            backend=model_backend,
        )
        act = plan.primary
        return {
            "dialogue_act": act,
            "intent_patch": act.patch or IntentPatch(),
            "turn_plan": plan,
            "decided_route": None,
        }

    return classify_dialogue_act


async def apply_turn_effects(state: MissionGraphState) -> dict:
    """把已分类行为的信念副作用落到任务上（价格态度 / 否定聚焦 / 不支持维度）。

    控制反转后由图承担（原属命令层 DialoguePolicy）；与 DialoguePolicy 共用
    apply_act_effects，保证确定性与 LLM 两条路径信念演化一致。"""
    mission = state["mission"]
    plan = state.get("turn_plan")
    ops = list(getattr(plan, "ops", None) or [])
    act = state.get("dialogue_act")
    if act is not None and act not in ops:
        ops = [act, *ops]
    if not ops:
        return {}
    belief, dialogue = mission.belief, mission.dialogue
    for op in ops:
        if op.kind == DialogueActKind.UNDO:
            continue
        belief, dialogue = apply_act_effects(
            belief, dialogue, op, cache_payload=state.get("cache_payload")
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
    """兼容入口：只按世界变化选路，不再读 kind 查表。"""
    mission = state["mission"]
    return finish_world_route(
        state.get("turn_plan"),
        mission=mission,
        cache_payload=state.get("cache_payload"),
        skip_intent_patch=bool(state.get("skip_intent_patch")),
        constraints_before=state.get("constraints_before") or mission.constraints,
        decided_route=state.get("decided_route"),
        requires_clarification=bool(state.get("requires_clarification")),
        clarification_question=state.get("clarification_question"),
    )


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
        if act.kind == DialogueActKind.UNDO:
            text = state.get("agent_message") or NOTHING_TO_UNDO_MESSAGE
            return {
                "agent_message": text,
                "agent_snapshot_ids": [],
                "agent_citations": [],
                "agent_act": DialogueActKind.UNDO.value,
                "agent_topic": None,
                "agent_next_moves": [],
            }
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
