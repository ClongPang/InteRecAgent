"""测试替身：脚本化 ModelBackend。

放弃无 Key 底线后运行时不再有确定性编排 fallback，但 CI 仍须 hermetic：
FakeModelBackend 按预置的 tool-call 轨迹逐步吐出 AssistantTurn，让 Agent 研究循环
在不联网、可确定性回归的前提下被断言（守住硬约束 / 证据可追溯）。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

from backend.agent.nodes.decide import make_merge_mission_state
from backend.agent.nodes.dialogue import apply_turn_effects, route_turn
from backend.application.dto import AssistantTurn, ChatMessage, IntentPatch, ToolCall, ToolSpec
from backend.application.dto.belief import PreferenceBelief
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.errors import ModelUnavailableError
from backend.application.services.dialogue import classify_turn


@dataclass
class TurnPreview:
    """一次确定性话轮经真实图节点后的可断言产物。"""

    act: object
    mission: ShoppingMission
    route: str | None
    requires_clarification: bool

    @property
    def constraints(self) -> MissionConstraints:
        return self.mission.constraints

    @property
    def belief(self) -> PreferenceBelief:
        return self.mission.belief


async def _drive_turn(mission: ShoppingMission, text: str, cache_payload: dict | None) -> TurnPreview:
    state: dict = {
        "mission": mission,
        "run_id": "r-eval",
        "text": text,
        "skip_intent_patch": False,
        "cache_payload": cache_payload,
        "turn_context": {},
    }
    act = classify_turn(text, current_query=mission.constraints.query)
    state["dialogue_act"] = act
    state["intent_patch"] = act.patch or IntentPatch()
    state.update(await apply_turn_effects(state))
    state.update(await make_merge_mission_state()(state))
    state.update(await route_turn(state))
    return TurnPreview(
        act=state["dialogue_act"],
        mission=state["mission"],
        route=state.get("turn_route"),
        requires_clarification=bool(state.get("requires_clarification")),
    )


def deterministic_turn(
    mission: ShoppingMission, text: str, *, cache_payload: dict | None = None
) -> TurnPreview:
    """驱动运行时确定性话轮流水线（classify_turn→apply_turn_effects→merge→route_turn）。

    离线断言直接跑真实图节点，杜绝与运行时的平行实现漂移。"""
    return asyncio.run(_drive_turn(mission, text, cache_payload))


def tool_turn(*calls: tuple[str, dict]) -> AssistantTurn:
    """构造一次发起若干工具调用的模型应答。"""
    return AssistantTurn(
        tool_calls=[
            ToolCall(id=f"call_{index}", name=name, arguments=args)
            for index, (name, args) in enumerate(calls)
        ]
    )


class FakeModelBackend:
    """按脚本轨迹应答的 ModelBackend。轨迹耗尽后返回终稿（无 tool_calls）。"""

    def __init__(self, turns: list[AssistantTurn] | None = None) -> None:
        self._turns = list(turns or [])
        self.chat_calls: list[list[ChatMessage]] = []

    def is_configured(self) -> bool:
        return True

    def supports_tools(self) -> bool:
        return True

    async def chat(
        self, *, messages: list[ChatMessage], tools: list[ToolSpec]
    ) -> AssistantTurn:
        del tools
        self.chat_calls.append(list(messages))
        if self._turns:
            return self._turns.pop(0)
        return AssistantTurn(content="done")

    async def parse_intent(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: parse_intent 未脚本化")

    async def parse_turn(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: parse_turn 未脚本化")

    async def draft_recommendation(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: draft_recommendation 未脚本化")
