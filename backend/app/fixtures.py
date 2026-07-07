from __future__ import annotations

from backend.app.schemas import (
    Budget,
    ChatTurnResponse,
    ClarificationPayload,
    Constraint,
    ConstraintCheck,
    EvidenceItem,
    FeedbackRecord,
    IntentState,
    ProductRecommendation,
    SuggestedAction,
    TraceSummary,
    UnsupportedPayload,
)


DEMO_PRODUCTS = [
    ProductRecommendation(
        product_id="prod_headphones_001",
        title="AeroLite Wireless Commuter Headphones",
        brand="AeroLite",
        price=79.99,
        image_url=None,
        category_path=["Electronics", "Headphones", "Wireless"],
        leaf_category="Wireless Headphones",
        average_rating=4.4,
        review_count=824,
        matched_tags=["under $100", "commuting", "comfortable"],
        evidence=[
            EvidenceItem(
                source="review",
                product_id="prod_headphones_001",
                text="Reviewers repeatedly mention light weight and comfortable long-wear fit.",
            )
        ],
        uncertainties=["Battery life varies by listening volume."],
        constraint_status="satisfied",
        constraint_checks=[
            ConstraintCheck(field="price", status="satisfied", reason="79.99 <= 100")
        ],
        score_breakdown={"intent_match": 0.84, "price_fit": 0.9, "evidence": 0.72},
        rank_reason="Best balance of comfort evidence, commute fit, and budget.",
        rank=1,
    ),
    ProductRecommendation(
        product_id="prod_headphones_002",
        title="MetroBeat Compact Wireless Headphones",
        brand="MetroBeat",
        price=None,
        image_url=None,
        category_path=["Electronics", "Headphones", "Wireless"],
        leaf_category="Wireless Headphones",
        average_rating=4.1,
        review_count=311,
        matched_tags=["compact", "portable"],
        evidence=[],
        uncertainties=["price unknown", "review evidence missing"],
        constraint_status="unknown",
        constraint_checks=[
            ConstraintCheck(
                field="price",
                status="unknown",
                reason="Catalog price is missing and cannot be claimed under budget.",
            )
        ],
        score_breakdown={"intent_match": 0.68, "price_fit": 0.0, "evidence": 0.2},
        rank_reason="Close match, but price and evidence are incomplete.",
        rank=2,
    ),
]


def build_intent(message: str, feedback_type: str | None = None) -> IntentState:
    lower_message = message.lower()
    intent = IntentState(
        task_type="negative_feedback" if feedback_type else "single_item_recommendation",
        category="wireless headphones" if "headphone" in lower_message else "catalog item",
        goal="commuting" if "commut" in lower_message else "shopping recommendation",
        scenario="daily commute" if "commut" in lower_message else "",
        budget=Budget(max=100, currency="USD") if "100" in lower_message else None,
        priority_order=["comfort", "battery"] if "battery" in lower_message else ["fit", "evidence"],
        hard_constraints=[
            Constraint(field="price", op="<=", value=100)
        ]
        if "100" in lower_message
        else [],
        soft_preferences=["comfortable", "portable"],
        uncertainty_fields=[] if "headphone" in lower_message else ["category"],
    )
    if feedback_type:
        intent.feedback_history.append(
            FeedbackRecord(
                turn_id="turn_001",
                feedback_text=message,
                feedback_type=feedback_type,
                anchor_product_id="prod_headphones_001",
            )
        )
        if feedback_type == "brand":
            intent.negative_preferences.append("AeroLite")
        if feedback_type == "price":
            intent.price_sensitivity = "high"
    return intent


def build_chat_response(
    message: str,
    session_id: str = "sess_demo",
    turn_id: str = "turn_001",
    feedback_type: str | None = None,
) -> ChatTurnResponse:
    lower_message = message.lower()
    if any(term in lower_message for term in ["buy", "checkout", "shipping", "in stock"]):
        intent = IntentState(task_type="unsupported", category="catalog item")
        trace = TraceSummary(
            turn_id=turn_id,
            task_type="unsupported",
            intent_summary={"category": intent.category},
            clarification_decision={"should_clarify": False},
            warnings=["live commerce action unsupported"],
        )
        return ChatTurnResponse(
            session_id=session_id,
            turn_id=turn_id,
            status="unsupported",
            task_type="unsupported",
            message="I cannot check live stock, shipping, payment, or checkout in this demo. I can still recommend catalog-backed alternatives.",
            intent_state=intent,
            unsupported=UnsupportedPayload(
                reason="Live commerce action is outside MVP scope.",
                can_do=["Recommend products from the loaded catalog", "Explain known product evidence"],
                cannot_do=["Live inventory", "Payment", "Checkout", "Shipping"],
            ),
            trace_summary=trace,
            suggested_actions=[
                SuggestedAction(label="Show catalog alternatives", action_type="recommend")
            ],
        )

    if "something for work" in lower_message:
        intent = IntentState(
            task_type="single_item_recommendation",
            goal="work",
            uncertainty_fields=["category"],
        )
        trace = TraceSummary(
            turn_id=turn_id,
            task_type="single_item_recommendation",
            intent_summary={"goal": "work", "uncertainty_fields": ["category"]},
            clarification_decision={"should_clarify": True, "reason": "missing category"},
            warnings=["category is ambiguous"],
        )
        return ChatTurnResponse(
            session_id=session_id,
            turn_id=turn_id,
            status="clarification_required",
            task_type="single_item_recommendation",
            message="What kind of product should I focus on for work?",
            intent_state=intent,
            clarification=ClarificationPayload(
                question="What kind of product should I focus on for work?",
                options=["Headphones", "Mouse", "Desk accessory"],
            ),
            trace_summary=trace,
        )

    intent = build_intent(message, feedback_type)
    filtered_count = 18 if feedback_type else 12
    trace = TraceSummary(
        turn_id=turn_id,
        task_type=intent.task_type,
        intent_summary={
            "category": intent.category,
            "budget": intent.budget.model_dump() if intent.budget else None,
            "negative_preferences": intent.negative_preferences,
        },
        clarification_decision={"should_clarify": False},
        retrieved_count=80,
        filtered_count=filtered_count,
        ranking_summary={"top_score": 0.84, "ranker": "mock_rule_ranker"},
        rerank_summary={"mode": "mock", "changed_order": False},
        evidence_sources=["review", "metadata"],
        feedback_update={"feedback_type": feedback_type} if feedback_type else None,
        warnings=["Some product facts are unknown and labeled explicitly."],
    )
    return ChatTurnResponse(
        session_id=session_id,
        turn_id=turn_id,
        status="recommendations_ready",
        task_type=intent.task_type,
        message=(
            "I updated the recommendations based on your feedback."
            if feedback_type
            else "I found catalog-backed recommendations that match your request."
        ),
        intent_state=intent,
        products=DEMO_PRODUCTS,
        trace_summary=trace,
        suggested_actions=[
            SuggestedAction(
                label="Show cheaper",
                action_type="feedback",
                payload={"feedback_type": "price", "anchor_product_id": "prod_headphones_001"},
            ),
            SuggestedAction(
                label="Avoid this brand",
                action_type="feedback",
                payload={"feedback_type": "brand", "anchor_product_id": "prod_headphones_001"},
            ),
        ],
    )
