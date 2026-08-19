"""未配置 LLM 的 fallback（P3-W03、AGT-006）。

任何调用返回明确的 capability unavailable（ModelUnavailableError），不抛未处理异常；
Agent 捕获后走确定性解析/模板解释，保证无模型 Key 时完整图可验收。
"""
from __future__ import annotations

from ...application.dto import DialogueAct, IntentPatch, RecommendationDraft
from ...application.errors import ModelUnavailableError


class UnconfiguredModelBackend:
    """未配置模型后端。is_configured()=False，能力调用一律抛 ModelUnavailableError。"""

    def is_configured(self) -> bool:
        return False

    async def parse_intent(self, text: str) -> IntentPatch:
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性解析器"
        )

    async def parse_turn(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> DialogueAct:
        del context
        raise ModelUnavailableError(
            "LLM 未配置（llm_provider=unconfigured），请使用确定性对话分类"
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
