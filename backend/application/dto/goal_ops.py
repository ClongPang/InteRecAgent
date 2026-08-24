from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class GoalOperationKind(StrEnum):
    SET_TARGET = "set_target"
    UPSERT_CONSTRAINT = "upsert_constraint"
    RETRACT_CONSTRAINT = "retract_constraint"
    SET_RETRIEVAL_SCOPE = "set_retrieval_scope"
    ADD_PREFERENCE = "add_preference"
    REJECT_CANDIDATE = "reject_candidate"
    CORRECT_UNDERSTANDING = "correct_understanding"
    ASK_FACT = "ask_fact"
    COMPARE_CANDIDATES = "compare_candidates"
    UNDO = "undo"
    REQUEST_RESEARCH = "request_research"


class GoalOperation(BaseModel):
    op_id: str
    kind: GoalOperationKind
    payload: dict[str, Any] = Field(default_factory=dict)
    confidence: float = 1.0
    origin: str = "deterministic"
    source_turn_id: str | None = None
    source_span: str | None = None
    precondition_goal_version: int
