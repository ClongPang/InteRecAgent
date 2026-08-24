from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class QueryPurpose(StrEnum):
    RECALL = "recall"
    RECALL_REFINEMENT = "recall_refinement"
    EVIDENCE_SUPPLEMENT = "evidence_supplement"
    MARKET_EXPANSION = "market_expansion"
    BUDGET_CAP_RELAXATION = "budget_cap_relaxation"


class ResearchQueryTrace(BaseModel):
    query: str
    markets: list[str] = Field(default_factory=list)
    purpose: QueryPurpose
    search_index: int


class ResearchProposal(BaseModel):
    proposal_id: str
    kind: str
    status: str = "pending_user_confirmation"
    reason_code: str
    payload: dict[str, Any] = Field(default_factory=dict)
