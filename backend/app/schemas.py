from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field


TaskType = Literal[
    "single_item_recommendation",
    "negative_feedback",
    "alternative_recommendation",
    "comparison",
    "gift_recommendation",
    "bundle_recommendation",
    "unsupported",
]

ChatTurnStatus = Literal[
    "clarification_required",
    "recommendations_ready",
    "unsupported",
    "partial_support",
    "error",
]

ConstraintStatus = Literal["satisfied", "violated", "unknown"]


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "InteRecAgent API"
    version: str = "0.1.0"


class ErrorResponse(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class Budget(BaseModel):
    max: float | None = None
    currency: str = "USD"


class Constraint(BaseModel):
    field: str
    op: str
    value: Any


class FeedbackRecord(BaseModel):
    turn_id: str
    feedback_text: str
    feedback_type: str | None = None
    anchor_product_id: str | None = None


class IntentState(BaseModel):
    task_type: TaskType = "single_item_recommendation"
    category: str = ""
    goal: str = ""
    scenario: str = ""
    budget: Budget | None = None
    brand_preference: list[str] = Field(default_factory=list)
    price_sensitivity: str = ""
    priority_order: list[str] = Field(default_factory=list)
    hard_constraints: list[Constraint] = Field(default_factory=list)
    soft_preferences: list[str] = Field(default_factory=list)
    negative_preferences: list[str] = Field(default_factory=list)
    target_user: str = ""
    uncertainty_fields: list[str] = Field(default_factory=list)
    feedback_history: list[FeedbackRecord] = Field(default_factory=list)
    long_term_profile: dict[str, Any] = Field(default_factory=dict)


class EvidenceItem(BaseModel):
    source: Literal["metadata", "review", "rating", "profile"]
    text: str
    product_id: str | None = None


class ClaimEvidenceRecord(BaseModel):
    claim: str
    product_id: str | None = None
    evidence_type: Literal["metadata", "review", "rating", "profile", "unknown"]
    evidence_text: str | None = None
    supported: bool = False


class ConstraintCheck(BaseModel):
    field: str
    status: ConstraintStatus
    reason: str


class ProductRecommendation(BaseModel):
    product_id: str
    title: str
    brand: str | None = None
    price: float | None = None
    currency: str = "USD"
    image_url: str | None = None
    category_path: list[str] = Field(default_factory=list)
    leaf_category: str | None = None
    average_rating: float | None = None
    review_count: int = 0
    matched_tags: list[str] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list)
    constraint_status: ConstraintStatus = "unknown"
    constraint_checks: list[ConstraintCheck] = Field(default_factory=list)
    score_breakdown: dict[str, float] = Field(default_factory=dict)
    rank_reason: str | None = None
    rank: int
    claim_evidence: list[ClaimEvidenceRecord] = Field(default_factory=list)


class ClarificationPayload(BaseModel):
    question: str
    options: list[str] = Field(default_factory=list)
    allow_free_answer: bool = True
    allow_skip: bool = True
    allow_recommend_anyway: bool = True


class UnsupportedPayload(BaseModel):
    reason: str
    can_do: list[str] = Field(default_factory=list)
    cannot_do: list[str] = Field(default_factory=list)


class SuggestedAction(BaseModel):
    label: str
    action_type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class TraceSummary(BaseModel):
    turn_id: str
    task_type: TaskType
    intent_summary: dict[str, Any] = Field(default_factory=dict)
    clarification_decision: dict[str, Any] = Field(default_factory=dict)
    retrieved_count: int = 0
    filtered_count: int = 0
    ranking_summary: dict[str, Any] = Field(default_factory=dict)
    rerank_summary: dict[str, Any] = Field(default_factory=dict)
    evidence_sources: list[str] = Field(default_factory=list)
    feedback_update: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)


class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str
    turn_id: str | None = None
    feedback_text: str | None = None
    feedback_type: str | None = None
    anchor_product_id: str | None = None


class ChatTurnResponse(BaseModel):
    session_id: str
    turn_id: str
    status: ChatTurnStatus
    task_type: TaskType
    message: str
    intent_state: IntentState
    products: list[ProductRecommendation] = Field(default_factory=list)
    clarification: ClarificationPayload | None = None
    comparison: dict[str, Any] | None = None
    unsupported: UnsupportedPayload | None = None
    trace_summary: TraceSummary
    suggested_actions: list[SuggestedAction] = Field(default_factory=list)


class SessionState(BaseModel):
    session_id: str
    messages: list[dict[str, str]] = Field(default_factory=list)
    current_intent: IntentState = Field(default_factory=IntentState)


class InternalTrace(BaseModel):
    turn_id: str
    session_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    input: str
    task_route: dict[str, Any] = Field(default_factory=dict)
    intent_before: dict[str, Any] = Field(default_factory=dict)
    intent_after: dict[str, Any] = Field(default_factory=dict)
    feedback_update: dict[str, Any] = Field(default_factory=dict)
    clarification: dict[str, Any] = Field(default_factory=dict)
    retrieval: dict[str, Any] = Field(default_factory=dict)
    filtering: dict[str, Any] = Field(default_factory=dict)
    constraint_checks: list[dict[str, Any]] = Field(default_factory=list)
    ranking: dict[str, Any] = Field(default_factory=dict)
    llm_rerank: dict[str, Any] = Field(default_factory=dict)
    final_validation: dict[str, Any] = Field(default_factory=dict)
    response: dict[str, Any] = Field(default_factory=dict)
    latency_ms: dict[str, float] = Field(default_factory=dict)
    errors: list[dict[str, Any]] = Field(default_factory=list)


class EvaluationRunSummary(BaseModel):
    run_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    metrics: dict[str, float]
    case_failures: list[dict[str, Any]] = Field(default_factory=list)


class ReplayResult(BaseModel):
    turn_id: str
    replayed: bool
    stages: list[str]
