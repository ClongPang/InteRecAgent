"""追问判定节点（AGT-006、BUS-002）。"""
from __future__ import annotations

from ...application.dto import RunnerStatus
from ...application.errors import ModelUnavailableError
from ...application.ports import ModelBackend
from ..state import MissionGraphState
from .parse_intent import parse_intent


def make_parse_intent_patch(model_backend: ModelBackend):
    """解析用户输入为结构化条件增量。模型可用时优先模型，否则确定性解析（P3-W03）。"""

    async def parse_intent_patch(state: MissionGraphState) -> dict:
        text = state.get("text", "")
        if model_backend.is_configured():
            try:
                patch = await model_backend.parse_intent(text)
                return {"intent_patch": patch}
            except ModelUnavailableError:
                pass  # 模型临时不可用 → 确定性 fallback，不阻塞验收
        return {"intent_patch": parse_intent(text)}

    return parse_intent_patch


async def need_clarification(state: MissionGraphState) -> dict:
    """判断是否需要追问；是则本节点结束，由条件边分流到持久化。"""
    if state.get("requires_clarification"):
        return {"status": RunnerStatus.COMPLETED}
    return {}
