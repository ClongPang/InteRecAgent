"""Agent 工具循环的对话原语（ModelBackend.chat 契约，AGT-001 动态 tool-use）。

这些 DTO 描述「LLM 控制循环」与工具之间的消息，是 ModelBackend Port 的一部分：
LLM 只被允许发起结构化 tool_call 或给出终稿文本，事实字段仍由确定性工具与快照回填。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolSpec(BaseModel):
    """暴露给 LLM 的工具签名（JSON Schema 描述参数）。"""

    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class ToolCall(BaseModel):
    """LLM 发起的一次工具调用意图。arguments 已解析为对象。"""

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ChatMessage(BaseModel):
    """一条对话消息。tool 角色回传工具结果，assistant 角色可携带 tool_calls。"""

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None


class AssistantTurn(BaseModel):
    """模型一次应答：要么发起工具调用，要么给出终稿文本（无 tool_calls 即终止）。"""

    content: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)

    @property
    def is_final(self) -> bool:
        return not self.tool_calls
