from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class AssessmentVerdict(StrEnum):
    SATISFIED = "satisfied"
    VIOLATED = "violated"
    UNKNOWN = "unknown"


class CandidateEligibility(StrEnum):
    ELIGIBLE = "eligible"
    INELIGIBLE = "ineligible"
    NEEDS_EVIDENCE = "needs_evidence"


class SemanticProfileMethod(StrEnum):
    """How a semantic profile was produced.

    The value is persisted with the candidate set so a future model classifier
    cannot silently replace the deterministic safety guard.
    """

    RULE = "rule"
    MODEL = "model"
    ADJUDICATED = "adjudicated"


class EvidenceRef(BaseModel):
    snapshot_id: str | None = None
    source: str
    path: str
    json_path: str | None = None
    observed_at: datetime | None = None
    value: str | float | bool | None = None
    evidence_level: str = "observed"
    derivation_version: str | None = None


class ProductSemanticProfile(BaseModel):
    category_id: str | None = None
    item_type: str | None = None
    relation: str = "unknown"
    brand: str | None = None
    model: str | None = None
    derived_attrs: dict[str, str | float | bool] = Field(default_factory=dict)
    method: SemanticProfileMethod = SemanticProfileMethod.RULE
    confidence: float = 0.0
    evidence_spans: list[str] = Field(default_factory=list)
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)
    conflict_reason_codes: list[str] = Field(default_factory=list)
    classifier_version: str = "rules-v1"


class ConstraintAssessment(BaseModel):
    constraint_id: str
    # Legacy candidate-set payloads did not persist this at assessment level.
    # New writers must set it; zero is an explicit "legacy/unbound" sentinel.
    goal_version: int = 0
    verdict: AssessmentVerdict
    reason_code: str
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)
    evaluator_version: str = "v1"
    snapshot_id: str | None = None


class CandidateQualification(BaseModel):
    candidate_id: str
    goal_version: int
    profile: ProductSemanticProfile
    assessments: list[ConstraintAssessment] = Field(default_factory=list)
    eligibility: CandidateEligibility


class RankExplanation(BaseModel):
    candidate_id: str
    goal_version: int
    assessment_reason_codes: list[str] = Field(default_factory=list)
    ranking_reason_codes: list[str] = Field(default_factory=list)
    feature_scores: dict[str, float] = Field(default_factory=dict)
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)
