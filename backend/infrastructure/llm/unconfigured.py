"""未配置 LLM 的 fallback（P3-W03、AGT-006）。

任何调用返回明确的 capability unavailable（ModelUnavailableError），不抛未处理异常；
Agent 捕获后走确定性解析/模板解释，保证无模型 Key 时完整图可验收。
"""
from __future__ import annotations

from typing import Any

from ...application.dto import (
    AssistantTurn,
    ChatMessage,
    DialogueAct,
    IntentPatch,
    RecommendationDraft,
    SlotId,
    ToolSpec,
    TurnPlan,
)
from ...application.dto.probe import Uncertainty
from ...application.errors import ModelUnavailableError


class UnconfiguredModelBackend:
    """未配置模型后端。is_configured()=False，能力调用一律抛 ModelUnavailableError。"""

    def is_configured(self) -> bool:
        return False

    def supports_tools(self) -> bool:
        return False

    async def chat(
        self, *, messages: list[ChatMessage], tools: list[ToolSpec]
    ) -> AssistantTurn:
        del messages, tools
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），研究循环请走确定性驱动"
        )

    async def complete_json(self, *, system: str, user: str) -> dict[str, Any]:
        del system, user
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），研究循环请走确定性驱动"
        )

    async def parse_intent(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> IntentPatch:
        del current_query, context
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性解析器"
        )

    async def parse_decision(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> TurnPlan:
        del text, current_query, context
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性对话分类"
        )

    async def parse_turn(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> DialogueAct:
        del context
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性对话分类"
        )

    async def pick_probe(self, uncertainties: list[Uncertainty]) -> SlotId | None:
        del uncertainties
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性追问"
        )

    async def draft_recommendation(
        self,
        *,
        constraints: object,
        candidates: list[object],
        evidence: object,
    ) -> RecommendationDraft:
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性推荐"
        )
