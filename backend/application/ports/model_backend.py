from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from ..dto import (
    AssistantTurn,
    ChatMessage,
    DialogueAct,
    IntentPatch,
    RecommendationDraft,
    SlotId,
    ToolSpec,
    TurnPlan,
)
from ..dto.probe import Uncertainty


@runtime_checkable
class ModelBackend(Protocol):
    """LLM 后端 Port（AGT-003：只允许输出结构化 DTO / tool_call，不得直接输出最终价格/库存/链接）。

    编排接缝：
    - 研究环：``complete_json`` 做 keep / 改写 / TopK；未配置则跳过模型步。
    - 对话 / 起草：``parse_decision`` / ``parse_turn`` / ``parse_intent`` / ``draft_recommendation``。
    - ``chat`` + ``supports_tools`` 仍可用于探测原生 tool-calling，研究控环不再依赖它。
    未配置时由 UnconfiguredModelBackend 抛出 ModelUnavailableError。
    """

    def is_configured(self) -> bool: ...

    def supports_tools(self) -> bool:
        """是否可驱动动态 tool-use 循环；False 时研究子图走确定性驱动。"""
        ...

    async def chat(
        self, *, messages: list[ChatMessage], tools: list[ToolSpec]
    ) -> AssistantTurn:
        """一步对话：模型基于消息与工具签名，发起 tool_call 或给出终稿文本。"""
        ...

    async def complete_json(self, *, system: str, user: str) -> dict[str, Any]:
        """单次结构化 JSON 补全。研究环的 keep / 改写 / TopK 走这里，不走自由 tool-calling。"""
        ...

    async def parse_intent(
        self,
        text: str,
        *,
        current_query: str | None = None,
        context: dict | None = None,
    ) -> IntentPatch: ...

    async def parse_decision(
        self,
        text: str,
        *,
        current_query: str | None = None,
        context: dict | None = None,
    ) -> TurnPlan:
        """口语一次决策：优先 ``{ops:[...]}``；兼容单 act JSON。"""
        ...

    async def parse_turn(
        self,
        text: str,
        *,
        current_query: str | None = None,
        context: dict | None = None,
    ) -> DialogueAct: ...

    async def pick_probe(self, uncertainties: list[Uncertainty]) -> SlotId | None:
        """从封闭 Uncertainty 列表里挑一个 SlotId。不得发明列表外的槽。"""
        ...

    async def draft_recommendation(
        self,
        *,
        constraints: object,
        candidates: list[object],
        evidence: object,
    ) -> RecommendationDraft: ...
