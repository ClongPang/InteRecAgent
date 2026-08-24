from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class CoverageStatus(StrEnum):
    SUFFICIENT = "sufficient"
    INSUFFICIENT = "insufficient"
    BLOCKED_ON_EVIDENCE = "blocked_on_evidence"


class GoalCoverage(BaseModel):
    goal_version: int
    status: CoverageStatus
    eligible_count: int = 0
    ineligible_count: int = 0
    needs_evidence_count: int = 0
    blocking_reason_codes: list[str] = Field(default_factory=list)
    requested_markets: list[str] = Field(default_factory=list)
    covered_markets: list[str] = Field(default_factory=list)
    missing_markets: list[str] = Field(default_factory=list)
    identity_purity: float = 0.0
    hard_constraint_evidence_coverage: dict[str, float] = Field(default_factory=dict)
    preference_evidence_coverage: dict[str, float] = Field(default_factory=dict)
    attempted_candidate_count: int = 0
    search_attempt_count: int = 0
    request_count: int = 0
    request_budget: int | None = None
    remaining_request_budget: int | None = None
    remaining_time_ms: int | None = None
    model_call_count: int = 0
    model_call_budget: int | None = None
    remaining_model_calls: int | None = None
    estimated_token_count: int = 0
    token_budget: int | None = None
    remaining_token_budget: int | None = None
    marginal_unique_observations: int = 0
    marginal_eligible_count: int = 0
    consecutive_no_gain: int = 0
    stop_reason: str | None = None
