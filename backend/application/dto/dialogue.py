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
    STANCE = "express_stance"
    UNDO = "undo"
    META = "meta"
    UNKNOWN = "unknown"


class AskTopic(StrEnum):
    WARRANTY = "warranty"
    STOCK = "stock"
    WHY = "why"
    TRADEOFF = "tradeoff"
    OVERVIEW = "overview"


class TurnCommand(StrEnum):
    MESSAGE = "message"
    PATCH = "patch"
    UNDO = "undo"


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
    stance: str | None = None
    topic: AskTopic | None = None
    confidence: float = 1.0
    source: str = "deterministic"


class Citation(BaseModel):
    snapshot_id: str
    role: str = "primary"
    title: str | None = None
    estimated_cny: float | None = None
    market: str | None = None


class NextMove(BaseModel):
    label: str
    text: str


class ThreadChange(BaseModel):
    kind: str
    summary: str


class ThreadMessage(BaseModel):
    sequence: int
    kind: str
    role: str = "agent"
    text: str
    act: str | None = None
    topic: str | None = None
    constraints_version: int | None = None
    snapshot_ids: list[str] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    next_moves: list[NextMove] = Field(default_factory=list)
    change: ThreadChange | None = None
    run_id: str | None = None
    change_kind: str | None = None
    created_at: datetime | None = None


class ThreadView(BaseModel):
    messages: list[ThreadMessage] = Field(default_factory=list)
