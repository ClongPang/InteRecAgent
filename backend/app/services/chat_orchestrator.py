from __future__ import annotations

from backend.app.schemas import (
    ChatRequest,
    ChatTurnResponse,
    SuggestedAction,
    TraceSummary,
    UnsupportedPayload,
)
from backend.app.services.clarification_policy import ClarificationPolicy
from backend.app.services.constraint_verifier import ConstraintVerifier
from backend.app.services.feedback_updater import FeedbackUpdater
from backend.app.services.intent_parser import IntentParser
from backend.app.services.llm_reranker import LLMReranker
from backend.app.services.product_store import ProductStore
from backend.app.services.profile_store import ProfileStore
from backend.app.services.ranker import RuleRanker
from backend.app.services.response_generator import GroundedResponseGenerator
from backend.app.services.retriever import Retriever
from backend.app.services.task_router import TaskRouter


class ChatOrchestrator:
    def __init__(
        self,
        product_store: ProductStore | None = None,
        profile_store: ProfileStore | None = None,
    ) -> None:
        self.product_store = product_store or ProductStore()
        self.profile_store = profile_store or ProfileStore()
        self.task_router = TaskRouter()
        self.intent_parser = IntentParser()
        self.feedback_updater = FeedbackUpdater()
        self.clarification_policy = ClarificationPolicy()
        self.retriever = Retriever(self.product_store)
        self.constraint_verifier = ConstraintVerifier()
        self.ranker = RuleRanker()
        self.llm_reranker = LLMReranker()
        self.response_generator = GroundedResponseGenerator()

    def run(self, request: ChatRequest, allow_clarification: bool = True) -> ChatTurnResponse:
        session_id = request.session_id or "sess_demo"
        turn_id = request.turn_id or "turn_001"
        message = request.feedback_text or request.message
        route = self.task_router.route(message, request.feedback_type)
        intent = self.intent_parser.parse(message, route)
        profile = self.profile_store.get(request.user_id)
        if profile:
            intent.long_term_profile = profile
        feedback_update: dict[str, object] | None = None
        if request.feedback_text or request.feedback_type:
            anchor = (
                self.product_store.get(request.anchor_product_id)
                if request.anchor_product_id
                else None
            )
            intent, feedback_update = self.feedback_updater.apply(
                intent=intent,
                feedback_text=request.feedback_text or request.message,
                feedback_type=request.feedback_type,
                anchor=anchor,
                turn_id=turn_id,
            )

        if route.task_type == "unsupported":
            return self._unsupported(session_id, turn_id, route, intent)

        should_clarify, clarification, clarification_reason = self.clarification_policy.decide(
            intent, message
        )
        if should_clarify and allow_clarification:
            trace_summary = TraceSummary(
                turn_id=turn_id,
                task_type=route.task_type,
                intent_summary={
                    "goal": intent.goal,
                    "uncertainty_fields": intent.uncertainty_fields,
                },
                clarification_decision={
                    "should_clarify": True,
                    "reason": clarification_reason,
                },
                warnings=["category is ambiguous"],
            )
            return ChatTurnResponse(
                session_id=session_id,
                turn_id=turn_id,
                status="clarification_required",
                task_type=route.task_type,
                message=clarification.question if clarification else "Please clarify your request.",
                intent_state=intent,
                clarification=clarification,
                trace_summary=trace_summary,
            )

        retrieved = self.retriever.retrieve(intent, top_k=10)
        verified = self.constraint_verifier.verify(retrieved, intent)
        safe_candidates = self.constraint_verifier.final_validate(verified)
        ranked = self.ranker.rank(safe_candidates, intent)
        reranked, rerank_summary = self.llm_reranker.rerank(ranked, intent)
        response_message, grounded_products, _claims = self.response_generator.generate(
            intent, reranked, feedback_update
        )
        trace_summary = TraceSummary(
            turn_id=turn_id,
            task_type=route.task_type,
            intent_summary={
                "category": intent.category,
                "budget": intent.budget.model_dump() if intent.budget else None,
                "negative_preferences": intent.negative_preferences,
            },
            clarification_decision={
                "should_clarify": False,
                "reason": (
                    "clarification limit reached; recommending from available catalog evidence"
                    if should_clarify and not allow_clarification
                    else clarification_reason
                ),
            },
            retrieved_count=len(retrieved),
            filtered_count=len(retrieved) - len(safe_candidates),
            ranking_summary={
                "top_score": ranked[0].score_breakdown["total"] if ranked else 0,
                "ranker": "rule_ranker",
                "profile_applied": bool(profile),
                "profile_source": self.profile_store.source if profile else None,
            },
            rerank_summary=rerank_summary,
            evidence_sources=sorted(
                {item.source for product in grounded_products for item in product.evidence}
            ),
            feedback_update=feedback_update,
            warnings=self._warnings(grounded_products),
        )
        return ChatTurnResponse(
            session_id=session_id,
            turn_id=turn_id,
            status="recommendations_ready",
            task_type=route.task_type,
            message=response_message,
            intent_state=intent,
            products=grounded_products,
            trace_summary=trace_summary,
            suggested_actions=[
                SuggestedAction(
                    label="Show cheaper",
                    action_type="feedback",
                    payload={
                        "feedback_type": "price",
                        "anchor_product_id": grounded_products[0].product_id if grounded_products else None,
                    },
                ),
                SuggestedAction(
                    label="Avoid this brand",
                    action_type="feedback",
                    payload={
                        "feedback_type": "brand",
                        "anchor_product_id": grounded_products[0].product_id if grounded_products else None,
                    },
                ),
                SuggestedAction(
                    label="More portable",
                    action_type="feedback",
                    payload={
                        "feedback_type": "portable",
                        "anchor_product_id": grounded_products[0].product_id if grounded_products else None,
                    },
                ),
            ],
        )

    def _unsupported(self, session_id, turn_id, route, intent) -> ChatTurnResponse:
        trace_summary = TraceSummary(
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
            trace_summary=trace_summary,
            suggested_actions=[
                SuggestedAction(label="Show catalog alternatives", action_type="recommend")
            ],
        )

    def _warnings(self, products) -> list[str]:
        warnings = []
        if any(product.constraint_status == "unknown" for product in products):
            warnings.append("Some product facts are unknown and labeled explicitly.")
        if any(not product.evidence for product in products):
            warnings.append("Some products have missing evidence.")
        return warnings
