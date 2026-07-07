from __future__ import annotations

from backend.app.schemas import Budget, FeedbackRecord, IntentState, ProductRecommendation


class FeedbackUpdater:
    def apply(
        self,
        intent: IntentState,
        feedback_text: str,
        feedback_type: str | None,
        anchor: ProductRecommendation | None,
        turn_id: str,
    ) -> tuple[IntentState, dict[str, object]]:
        updated = intent.model_copy(deep=True)
        normalized_type = feedback_type or self._infer_type(feedback_text)
        updated.feedback_history.append(
            FeedbackRecord(
                turn_id=turn_id,
                feedback_text=feedback_text,
                feedback_type=normalized_type,
                anchor_product_id=anchor.product_id if anchor else None,
            )
        )
        update_reason = "recorded generic feedback"
        if normalized_type == "price":
            updated.price_sensitivity = "high"
            if anchor and anchor.price is not None:
                updated.budget = Budget(max=anchor.price, currency=anchor.currency)
                update_reason = f"prefer products below anchor price {anchor.price}"
        elif normalized_type == "brand" and anchor and anchor.brand:
            if anchor.brand not in updated.negative_preferences:
                updated.negative_preferences.append(anchor.brand)
            update_reason = f"exclude anchor brand {anchor.brand}"
        elif normalized_type == "portable":
            if "portable" not in updated.soft_preferences:
                updated.soft_preferences.append("portable")
            update_reason = "strengthened portable preference"
        return updated, {
            "feedback_type": normalized_type,
            "anchor_product_id": anchor.product_id if anchor else None,
            "update_reason": update_reason,
        }

    def _infer_type(self, feedback_text: str) -> str:
        lower_text = feedback_text.lower()
        if "expensive" in lower_text or "cheaper" in lower_text:
            return "price"
        if "brand" in lower_text or "avoid" in lower_text:
            return "brand"
        if "portable" in lower_text or "bulky" in lower_text:
            return "portable"
        return "generic"
