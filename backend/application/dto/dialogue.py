"""对话行为与线程投影。约束增量仍用 IntentPatch；本模块只描述「这一轮要干什么」。"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from .runner import IntentPatch


class DialogueActKind(StrEnum):
    REFINE = "refine_constraints"
    ASK_ITEM = "ask_about_item"
    COMPARE = "compare_items"
    REJECT = "reject_item"
    UNDO = "undo"
    META = "meta"
    UNKNOWN = "unknown"


class TurnRoute(StrEnum):
    """图条件边：检索是其中一条路，不是默认路径。"""

    CLARIFY = "clarify"
    TALK = "talk"
    REFILTER = "refilter"
    RESEARCH = "research"


class DialogueAct(BaseModel):
    kind: DialogueActKind
    patch: IntentPatch | None = None
    referent_ranks: list[int] = Field(default_factory=list)
    exclude_terms: list[str] = Field(default_factory=list)
    confidence: float = 1.0
    source: str = "deterministic"


class ThreadMessage(BaseModel):
    sequence: int
    kind: str
    text: str
    constraints_version: int | None = None
    snapshot_ids: list[str] = Field(default_factory=list)
    created_at: datetime | None = None


class ThreadView(BaseModel):
    messages: list[ThreadMessage] = Field(default_factory=list)
