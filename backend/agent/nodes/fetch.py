"""接收输入节点。只依赖注入的 UnitOfWork 工厂，不 import Infrastructure。

检索/汇率的抓取已收敛到 Agent 研究循环（agent/loop.py）与共享流水线（services/rec/pipeline.py），
不再是每步一个图节点。
"""
from __future__ import annotations

from collections.abc import Callable

from ...application.dto import RunnerStatus
from ...application.ports import UnitOfWork
from ...application.services.nlu import build_turn_context
from ..state import MissionGraphState

_CONSTRAINT_TRIGGERS = frozenset({"constraints.updated", "constraints.undo", "run.accepted"})


def make_receive_message(uow_factory: Callable[[], UnitOfWork]):
    """接收输入：加载任务，并绑定到本次 run_id 对应的触发事件。"""

    async def receive_message(state: MissionGraphState) -> dict:
        async with uow_factory() as uow:
            mission = await uow.missions.get(
                owner_id=state["owner_id"], mission_id=state["mission_id"]
            )
            if mission is None:
                return {"status": RunnerStatus.FAILED, "warnings": ["任务不存在"]}
            events = await uow.events.list_since(mission_id=state["mission_id"])
            cache_payload = None
            if mission.candidate_set_id:
                cache_payload = await uow.candidate_sets.get(mission.candidate_set_id)
        bound = _bind_trigger(mission, events, state["run_id"])
        bound["cache_payload"] = cache_payload
        bound["turn_context"] = build_turn_context(events, mission, cache_payload)
        return bound

    return receive_message


def _bind_trigger(mission, events: list[dict], run_id: str) -> dict:
    """把本次 run 绑定到其触发事件。

    优先 message.received：控制反转后调度器会为每个 run 追加 run.accepted（受理回执，
    亦属约束触发），若不优先取消息事件，会把用户话轮误判为「约束已就绪、跳过分类」，
    导致空 query 走向澄清。约束触发（PATCH/undo）不带 message.received，仍走 skip 分支。"""
    msg_match = None
    constraint_match = None
    latest_message = None
    for event in events:
        etype = event["event_type"]
        rid = event.get("payload", {}).get("run_id")
        if etype == "message.received":
            latest_message = event
            if rid == run_id:
                msg_match = event
        elif etype in _CONSTRAINT_TRIGGERS and rid == run_id:
            constraint_match = event
    if msg_match is not None:
        payload = msg_match["payload"]
        return {
            "mission": mission,
            "text": payload.get("text", ""),
            "skip_intent_patch": bool(payload.get("skip_intent_patch")),
            "decided_route": payload.get("turn_route"),
            "decided_act": payload.get("act_payload"),
        }
    if constraint_match is not None:
        return {"mission": mission, "text": "", "skip_intent_patch": True}
    text = ""
    if latest_message is not None:
        text = latest_message.get("payload", {}).get("text", "")
    return {"mission": mission, "text": text, "skip_intent_patch": False}
