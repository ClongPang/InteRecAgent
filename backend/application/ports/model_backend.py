from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..dto import DialogueAct, IntentPatch, RecommendationDraft


@runtime_checkable
class ModelBackend(Protocol):
    """LLM 后端 Port（AGT-003：只允许输出结构化 DTO，不得直接输出最终价格/库存/链接）。
    未配置时由 UnconfiguredModelBackend 实现抛出 ModelUnavailableError，Agent 走确定性 fallback。"""

    def is_configured(self) -> bool: ...

    async def parse_intent(self, text: str) -> IntentPatch: ...

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
