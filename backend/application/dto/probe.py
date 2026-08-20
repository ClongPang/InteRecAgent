"""可兑现的不确定槽。生产和评测共用 SlotId，避免追问与 RTE 两套语言。"""
from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

from .dialogue import NextMove


class SlotId(StrEnum):
    QUERY = "query"
    BUDGET = "budget"
    SPLIT = "split"
    REJECT_REASON = "reject_reason"


class ProbeOption(BaseModel):
    """点选后就是一句普通用户话，走既有 IntentPatch 合并。"""

    label: str
    text: str


class Uncertainty(BaseModel):
    slot: SlotId
    severity: float
    actionable: bool = True
    observation: str
    question: str
    options: list[ProbeOption] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)
    split_key: str | None = None


class Probe(BaseModel):
    """升格后的唯一追问。blocking 仅用于无 query。"""

    slot: SlotId
    question: str
    options: list[ProbeOption] = Field(default_factory=list)
    blocking: bool = False
    observation: str = ""
    evidence_ids: list[str] = Field(default_factory=list)
    split_key: str | None = None

    def next_moves(self) -> list[NextMove]:
        return [NextMove(label=item.label, text=item.text) for item in self.options]
