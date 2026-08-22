"""测试替身：脚本化 ModelBackend。

CI 须 hermetic：FakeModelBackend 按预置 JSON 或默认 keep-all / 不改写 / 先到先得 TopK
驱动研究环，不联网。
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from backend.agent.nodes.execute import apply_world_ops
from backend.application.dto import AssistantTurn, ChatMessage, IntentPatch, ToolSpec, TurnPlan
from backend.application.services.decide_oral import decide_oral_turn
from backend.infrastructure.llm.unconfigured import UnconfiguredModelBackend
from backend.application.dto.belief import PreferenceBelief
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.errors import ModelUnavailableError


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
    ranked = list((cache_payload or {}).get("ranked") or [])
    plan = await decide_oral_turn(
        text,
        current_query=mission.constraints.query,
        context={
            "ranked": ranked,
            "pool": list((cache_payload or {}).get("pool") or ranked),
        },
        ranked=ranked,
        backend=UnconfiguredModelBackend(),
    )
    act = plan.primary
    state["dialogue_act"] = act
    state["intent_patch"] = act.patch or IntentPatch()
    state["turn_plan"] = plan
    state.update(await apply_world_ops(state))
    return TurnPreview(
        act=state["dialogue_act"],
        mission=state["mission"],
        route=state.get("turn_route"),
        requires_clarification=bool(state.get("requires_clarification")),
    )


def deterministic_turn(
    mission: ShoppingMission, text: str, *, cache_payload: dict | None = None
) -> TurnPreview:
    """驱动运行时确定性话轮流水线（decide_oral→execute_world）。

    离线断言直接跑真实图节点，杜绝与运行时的平行实现漂移。"""
    return asyncio.run(_drive_turn(mission, text, cache_payload))


class FakeModelBackend:
    """按脚本应答的 ModelBackend。json_replies 耗尽后：keep 全留、改写 null、TopK 取前 k。"""

    def __init__(
        self,
        turns: list[AssistantTurn] | None = None,
        json_replies: list[dict[str, Any]] | None = None,
    ) -> None:
        self._turns = list(turns or [])
        self._json_replies = list(json_replies or [])
        self.chat_calls: list[list[ChatMessage]] = []
        self.json_calls: list[tuple[str, str]] = []

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

    async def complete_json(self, *, system: str, user: str) -> dict[str, Any]:
        self.json_calls.append((system, user))
        if self._json_replies:
            return self._json_replies.pop(0)
        try:
            payload = json.loads(user) if user.lstrip().startswith("{") else {}
        except json.JSONDecodeError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        task = payload.get("task")
        candidates = payload.get("candidates") if isinstance(payload.get("candidates"), list) else []
        ids = [str(item.get("id")) for item in candidates if isinstance(item, dict) and item.get("id")]
        if task == "keep":
            return {"keep": ids}
        if task == "rewrite":
            return {"query": None}
        if task == "select_topk":
            k = int(payload.get("k") or 6)
            return {"ranked": ids[:k]}
        return {"keep": ids, "query": None, "ranked": ids[:6]}

    async def parse_intent(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: parse_intent 未脚本化")

    async def parse_decision(self, *args, **kwargs):
        if getattr(self, "_decisions", None):
            return self._decisions.pop(0)
        act = await self.parse_turn(*args, **kwargs)
        return TurnPlan(ops=[act], leftover=[], lead=act)

    async def parse_turn(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: parse_turn 未脚本化")

    async def pick_probe(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: pick_probe 未脚本化")

    async def draft_recommendation(self, *args, **kwargs):
        raise ModelUnavailableError("fake backend: draft_recommendation 未脚本化")
