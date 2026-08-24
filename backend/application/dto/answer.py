from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field, model_validator

from .qualification import EvidenceRef


class ObligationStatus(StrEnum):
    ANSWERED = "answered"
    UNKNOWN = "unknown"
    NEEDS_RESEARCH = "needs_research"


class AnswerObligation(BaseModel):
    facet: str
    status: ObligationStatus


class AnswerPlan(BaseModel):
    goal_version: int = Field(ge=1)
    question_intents: list[str] = Field(default_factory=list)
    obligations: list[AnswerObligation] = Field(default_factory=list)
    scope_candidate_set_id: str | None = None
    missing_facets: list[str] = Field(default_factory=list)
    required_facets: list[str] = Field(default_factory=list)
    proposed_next_action: str | None = None


class AnswerClaim(BaseModel):
    claim_id: str
    subject: str
    predicate: str
    value: str | float | bool | None
    polarity: str = "positive"
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)
    wording_policy: str = "factual"


class ClaimLedger(BaseModel):
    goal_version: int = Field(ge=1)
    candidate_set_id: str | None = None
    claims: list[AnswerClaim] = Field(default_factory=list)


class DecisionBundle(BaseModel):
    """Immutable, version-bound result persisted for one completed decision."""

    goal_version: int = Field(ge=1)
    candidate_set_id: str | None = None
    answer_plan: AnswerPlan
    claim_ledger: ClaimLedger
    rendered_text: str
    rendered_claim_ids: list[str] = Field(default_factory=list)
    verification: str = "passed"
    schema_version: str = "decision-bundle-v1"

    @model_validator(mode="after")
    def validate_identity(self) -> DecisionBundle:
        if self.answer_plan.goal_version != self.goal_version:
            raise ValueError("answer plan is bound to a different goal version")
        if self.claim_ledger.goal_version != self.goal_version:
            raise ValueError("claim ledger is bound to a different goal version")
        if self.answer_plan.scope_candidate_set_id != self.candidate_set_id:
            raise ValueError("answer plan is bound to a different candidate set")
        if self.claim_ledger.candidate_set_id != self.candidate_set_id:
            raise ValueError("claim ledger is bound to a different candidate set")
        known_claim_ids = {claim.claim_id for claim in self.claim_ledger.claims}
        if not set(self.rendered_claim_ids).issubset(known_claim_ids):
            raise ValueError("rendered output references a claim outside the ledger")
        return self
