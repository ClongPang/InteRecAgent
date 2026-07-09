import pytest
from pydantic import ValidationError

from backend.app.schemas import (
    Budget,
    ChatRequest,
    ChatTurnResponse,
    ClaimEvidenceRecord,
    ClarificationPayload,
    Constraint,
    ConstraintCheck,
    ErrorResponse,
    EvaluationRunSummary,
    EvidenceItem,
    FeedbackRecord,
    HealthResponse,
    IntentState,
    InternalTrace,
    ProductRecommendation,
    ReplayResult,
    SessionState,
    SuggestedAction,
    SystemReadinessResponse,
    TraceSummary,
    UnsupportedPayload,
)


VALID_PRODUCT = {
    "product_id": "prod_schema_001",
    "title": "Schema Test Headphones",
    "brand": "SchemaAudio",
    "price": 79.99,
    "currency": "USD",
    "category_path": ["Electronics", "Headphones"],
    "leaf_category": "Wireless Headphones",
    "average_rating": 4.4,
    "review_count": 12,
    "matched_tags": ["portable"],
    "evidence": [
        {
            "source": "review",
            "text": "Reviewers mention a compact fit.",
            "product_id": "prod_schema_001",
        }
    ],
    "uncertainties": [],
    "constraint_status": "satisfied",
    "constraint_checks": [
        {"field": "price", "status": "satisfied", "reason": "79.99 <= 100"}
    ],
    "score_breakdown": {"total": 0.9},
    "rank_reason": "Good schema fixture.",
    "rank": 1,
    "claim_evidence": [
        {
            "claim": "Has supporting review evidence.",
            "product_id": "prod_schema_001",
            "evidence_type": "review",
            "evidence_text": "Reviewers mention a compact fit.",
            "supported": True,
        }
    ],
}


VALID_INTENT = {
    "task_type": "single_item_recommendation",
    "category": "wireless headphones",
    "goal": "commuting",
    "budget": {"max": 100, "currency": "USD"},
    "hard_constraints": [{"field": "price", "op": "<=", "value": 100}],
    "soft_preferences": ["portable"],
}


VALID_TRACE_SUMMARY = {
    "turn_id": "turn_schema_001",
    "task_type": "single_item_recommendation",
    "intent_summary": {"category": "wireless headphones"},
    "clarification_decision": {"should_clarify": False},
    "retrieved_count": 3,
    "filtered_count": 1,
    "ranking_summary": {"ranker": "rule_ranker"},
    "rerank_summary": {"mode": "mock"},
    "evidence_sources": ["review"],
}


VALID_CHAT_TURN = {
    "session_id": "sess_schema",
    "turn_id": "turn_schema_001",
    "status": "recommendations_ready",
    "task_type": "single_item_recommendation",
    "message": "I found catalog-backed recommendations.",
    "intent_state": VALID_INTENT,
    "products": [VALID_PRODUCT],
    "trace_summary": VALID_TRACE_SUMMARY,
    "suggested_actions": [
        {
            "label": "More portable",
            "action_type": "feedback",
            "payload": {"feedback_type": "portable", "anchor_product_id": "prod_schema_001"},
        }
    ],
}


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (HealthResponse, {}),
        (ErrorResponse, {"code": "not_found", "message": "Missing.", "details": {}}),
        (Budget, {"max": 100, "currency": "USD"}),
        (Constraint, {"field": "price", "op": "<=", "value": 100}),
        (
            FeedbackRecord,
            {
                "turn_id": "turn_schema_001",
                "feedback_text": "Too expensive",
                "feedback_type": "price",
                "anchor_product_id": "prod_schema_001",
            },
        ),
        (IntentState, VALID_INTENT),
        (
            EvidenceItem,
            {
                "source": "review",
                "text": "Reviewers mention comfort.",
                "product_id": "prod_schema_001",
            },
        ),
        (
            ClaimEvidenceRecord,
            {
                "claim": "Has review support.",
                "product_id": "prod_schema_001",
                "evidence_type": "review",
                "evidence_text": "Reviewers mention comfort.",
                "supported": True,
            },
        ),
        (ConstraintCheck, {"field": "price", "status": "satisfied", "reason": "ok"}),
        (
            ConstraintCheck,
            {"field": "price", "status": "unknown_noncritical", "reason": "optional attribute missing"},
        ),
        (
            ConstraintCheck,
            {"field": "price", "status": "unknown_critical", "reason": "required price missing"},
        ),
        (ProductRecommendation, VALID_PRODUCT),
        (ProductRecommendation, {**VALID_PRODUCT, "constraint_status": "unknown_critical"}),
        (
            ClarificationPayload,
            {
                "question": "Which product type?",
                "options": ["Headphones", "Mouse"],
                "allow_free_answer": True,
                "allow_skip": True,
                "allow_recommend_anyway": True,
            },
        ),
        (
            UnsupportedPayload,
            {
                "reason": "Live checkout is unavailable.",
                "can_do": ["Recommend catalog products"],
                "cannot_do": ["Checkout"],
            },
        ),
        (
            SuggestedAction,
            {
                "label": "Show cheaper",
                "action_type": "feedback",
                "payload": {"feedback_type": "price"},
            },
        ),
        (TraceSummary, VALID_TRACE_SUMMARY),
        (
            SystemReadinessResponse,
            {
                "ready": False,
                "gates": {
                    "catalog": {
                        "ready": False,
                        "errors": ["normalized catalog is missing"],
                        "warnings": [],
                    }
                },
                "errors": ["catalog: normalized catalog is missing"],
                "warnings": [],
            },
        ),
        (ChatRequest, {"message": "Recommend wireless headphones."}),
        (ChatTurnResponse, VALID_CHAT_TURN),
        (
            SessionState,
            {
                "session_id": "sess_schema",
                "messages": [{"role": "user", "content": "Recommend headphones."}],
                "current_intent": VALID_INTENT,
            },
        ),
        (
            InternalTrace,
            {
                "turn_id": "turn_schema_001",
                "session_id": "sess_schema",
                "input": "Recommend wireless headphones.",
                "task_route": {"task_type": "single_item_recommendation"},
                "intent_after": VALID_INTENT,
                "response": {"product_ids": ["prod_schema_001"]},
                "errors": [],
            },
        ),
        (
            EvaluationRunSummary,
            {
                "run_id": "eval_schema",
                "metrics": {
                    "task_type_accuracy": 1.0,
                    "intent_slot_f1": 1.0,
                    "constraint_satisfaction": 1.0,
                    "evidence_coverage": 1.0,
                    "feedback_recovery": 1.0,
                },
                "case_failures": [],
            },
        ),
        (ReplayResult, {"turn_id": "turn_schema_001", "replayed": True, "stages": ["route"]}),
    ],
)
def test_schema_accepts_valid_fixtures(model, payload):
    assert model.model_validate(payload)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (ErrorResponse, {"message": "Missing code."}),
        (Budget, {"max": "not-a-number", "currency": "USD"}),
        (Constraint, {"field": "price", "op": "<="}),
        (FeedbackRecord, {"turn_id": "turn_schema_001"}),
        (IntentState, {"task_type": "unsupported_live_checkout"}),
        (EvidenceItem, {"source": "unsupported", "text": "bad"}),
        (ClaimEvidenceRecord, {"claim": "bad", "evidence_type": "unsupported"}),
        (ConstraintCheck, {"field": "price", "status": "maybe", "reason": "bad"}),
        (ProductRecommendation, {"product_id": "prod_schema_001"}),
        (ProductRecommendation, {**VALID_PRODUCT, "constraint_status": "maybe"}),
        (ClarificationPayload, {"options": ["Headphones"]}),
        (UnsupportedPayload, {"can_do": []}),
        (SuggestedAction, {"label": "Show cheaper"}),
        (TraceSummary, {"turn_id": "turn_schema_001", "task_type": "live_checkout"}),
        (ChatRequest, {"session_id": "sess_schema"}),
        (ChatTurnResponse, {**VALID_CHAT_TURN, "status": "done"}),
        (SessionState, {"messages": []}),
        (InternalTrace, {"turn_id": "turn_schema_001", "session_id": "sess_schema"}),
        (EvaluationRunSummary, {"metrics": {}}),
        (ReplayResult, {"turn_id": "turn_schema_001", "replayed": True}),
    ],
)
def test_schema_rejects_invalid_fixtures(model, payload):
    with pytest.raises(ValidationError):
        model.model_validate(payload)
