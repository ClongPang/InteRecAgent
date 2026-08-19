from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..dto import (
    AssistantTurn,
    ChatMessage,
    DialogueAct,
    IntentPatch,
    RecommendationDraft,
    ToolSpec,
)


@runtime_checkable
class ModelBackend(Protocol):
    """LLM 后端 Port（AGT-003：只允许输出结构化 DTO / tool_call，不得直接输出最终价格/库存/链接）。

    编排接缝分两代（绞杀式迁移）：
    - 动态 tool-use：``supports_tools`` + ``chat`` 驱动 LLM 自主编排的研究循环（AGT-001）。
    - 受约束增强（遗留）：``parse_intent`` / ``parse_turn`` / ``draft_recommendation``，
      供尚未反转控制流的对话/推荐路径使用，Phase 3 完成后移除。
    未配置时由 UnconfiguredModelBackend 抛出 ModelUnavailableError，研究循环退回确定性驱动。
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

    async def parse_intent(
        self,
        text: str,
        *,
        current_query: str | None = None,
        context: dict | None = None,
    ) -> IntentPatch: ...

    async def parse_turn(
        self,
        text: str,
        *,
        current_query: str | None = None,
        context: dict | None = None,
    ) -> DialogueAct: ...

    async def draft_recommendation(
        self,
        *,
        constraints: object,
        candidates: list[object],
        evidence: object,
    ) -> RecommendationDraft: ...
