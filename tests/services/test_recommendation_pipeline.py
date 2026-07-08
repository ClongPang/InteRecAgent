from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.constraint_verifier import ConstraintVerifier
from backend.app.services.feedback_updater import FeedbackUpdater
from backend.app.services.intent_parser import IntentParser
from backend.app.services.product_store import ProductStore
from backend.app.services.profile_store import ProfileStore
from backend.app.services.ranker import RuleRanker
from backend.app.services.retriever import Retriever
from backend.app.services.task_router import TaskRouter


def test_constraint_verifier_excludes_budget_violations_and_marks_unknown_price():
    store = ProductStore(load_default_artifact=False)
    route = TaskRouter().route("Recommend wireless headphones under 100 dollars")
    intent = IntentParser().parse("Recommend wireless headphones under 100 dollars", route)
    candidates = Retriever(store).retrieve(intent)
    verified = ConstraintVerifier().verify(candidates, intent)
    safe = ConstraintVerifier().final_validate(verified)

    assert "prod_headphones_003" not in [product.product_id for product in safe]
    unknown = next(product for product in safe if product.product_id == "prod_headphones_002")
    assert unknown.constraint_status == "unknown"


def test_feedback_updater_adds_anchor_brand_to_negative_preferences():
    store = ProductStore(load_default_artifact=False)
    anchor = store.get("prod_headphones_001")
    intent = IntentParser().parse(
        "Recommend wireless headphones",
        TaskRouter().route("Recommend wireless headphones"),
    )

    updated, diff = FeedbackUpdater().apply(intent, "Avoid this brand", "brand", anchor, "turn_001")

    assert "AeroLite" in updated.negative_preferences
    assert diff["anchor_product_id"] == "prod_headphones_001"


def test_feedback_updater_lowers_budget_to_anchor_price_for_cheaper_feedback():
    store = ProductStore(load_default_artifact=False)
    anchor = store.get("prod_headphones_001")
    intent = IntentParser().parse(
        "Recommend wireless headphones under 100 dollars",
        TaskRouter().route("Recommend wireless headphones under 100 dollars"),
    )

    updated, diff = FeedbackUpdater().apply(intent, "Too expensive", "price", anchor, "turn_001")

    assert updated.budget is not None
    assert updated.budget.max == 79.99
    assert diff["feedback_type"] == "price"


def test_chat_orchestrator_filters_hard_violations_and_returns_trace_summary():
    response = ChatOrchestrator().run(
        ChatRequest(message="Recommend wireless headphones under 100 dollars for commuting.")
    )

    product_ids = [product.product_id for product in response.products]
    assert "prod_headphones_003" not in product_ids
    assert response.trace_summary.filtered_count == 1
    assert response.trace_summary.ranking_summary["ranker"] == "rule_ranker"
    portable_action = next(
        action for action in response.suggested_actions if action.label == "More portable"
    )
    assert portable_action.action_type == "feedback"
    assert portable_action.payload == {
        "feedback_type": "portable",
        "anchor_product_id": response.products[0].product_id,
    }


def test_chat_orchestrator_applies_brand_feedback_before_retrieval_results():
    response = ChatOrchestrator().run(
        ChatRequest(
            message="Avoid this brand",
            feedback_text="Avoid this brand",
            feedback_type="brand",
            anchor_product_id="prod_headphones_001",
        )
    )

    assert "AeroLite" in response.intent_state.negative_preferences
    assert "prod_headphones_001" not in [product.product_id for product in response.products]
    assert response.trace_summary.feedback_update is not None


def test_chat_orchestrator_can_skip_clarification_when_limit_is_reached():
    response = ChatOrchestrator().run(
        ChatRequest(message="I need something for work"),
        allow_clarification=False,
    )

    assert response.status == "recommendations_ready"
    assert response.clarification is None
    assert response.products
    assert response.trace_summary.clarification_decision["reason"] == (
        "clarification limit reached; recommending from available catalog evidence"
    )


def test_rule_ranker_applies_profile_affinity_without_restoring_violations():
    store = ProductStore(load_default_artifact=False)
    route = TaskRouter().route("Recommend wireless headphones under 100 dollars")
    intent = IntentParser().parse("Recommend wireless headphones under 100 dollars", route)
    intent.long_term_profile = {
        "user_id": "U_PROFILE",
        "preferred_categories": [{"category": "Wireless Headphones", "count": 3}],
        "positive_product_ids": ["prod_headphones_002"],
        "negative_product_ids": [],
    }
    candidates = Retriever(store).retrieve(intent)
    verified = ConstraintVerifier().verify(candidates, intent)
    safe = ConstraintVerifier().final_validate(verified)

    ranked = RuleRanker().rank(safe, intent)

    assert "prod_headphones_003" not in [product.product_id for product in ranked]
    boosted = next(product for product in ranked if product.product_id == "prod_headphones_002")
    assert boosted.score_breakdown["profile_affinity"] > 0


def test_chat_orchestrator_uses_user_profile_for_ranking_trace():
    orchestrator = ChatOrchestrator(
        product_store=ProductStore(load_default_artifact=False),
        profile_store=ProfileStore(
            profiles={
                "U_PROFILE": {
                    "user_id": "U_PROFILE",
                    "preferred_categories": [{"category": "Wireless Headphones", "count": 3}],
                    "positive_product_ids": ["prod_headphones_002"],
                    "negative_product_ids": [],
                }
            }
        ),
    )

    response = orchestrator.run(
        ChatRequest(
            user_id="U_PROFILE",
            message="Recommend compact portable wireless headphones",
        )
    )

    assert response.intent_state.long_term_profile["user_id"] == "U_PROFILE"
    assert response.trace_summary.ranking_summary["profile_applied"] is True
    assert any(product.score_breakdown["profile_affinity"] > 0 for product in response.products)
