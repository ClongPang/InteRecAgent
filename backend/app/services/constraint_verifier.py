from __future__ import annotations

from backend.app.schemas import ConstraintCheck, IntentState, ProductRecommendation


class ConstraintVerifier:
    def verify(
        self, candidates: list[ProductRecommendation], intent: IntentState
    ) -> list[ProductRecommendation]:
        verified: list[ProductRecommendation] = []
        for product in candidates:
            checks: list[ConstraintCheck] = []
            status = "satisfied"
            if intent.budget and intent.budget.max is not None:
                if product.price is None:
                    checks.append(
                        ConstraintCheck(
                            field="price",
                            status="unknown_critical",
                            reason="Catalog price is missing and cannot be claimed under budget.",
                        )
                    )
                    status = "unknown_critical"
                elif product.price <= intent.budget.max:
                    checks.append(
                        ConstraintCheck(
                            field="price",
                            status="satisfied",
                            reason=f"{product.price:.2f} <= {intent.budget.max:.2f}",
                        )
                    )
                else:
                    checks.append(
                        ConstraintCheck(
                            field="price",
                            status="violated",
                            reason=f"{product.price:.2f} > {intent.budget.max:.2f}",
                        )
                    )
                    status = "violated"

            if product.brand and product.brand in intent.negative_preferences:
                checks.append(
                    ConstraintCheck(
                        field="brand",
                        status="violated",
                        reason=f"{product.brand} is in negative preferences.",
                    )
                )
                status = "violated"

            product.constraint_checks = checks
            product.constraint_status = status  # type: ignore[assignment]
            verified.append(product)
        return verified

    def final_validate(
        self,
        candidates: list[ProductRecommendation],
        minimum_confident_recommendations: int = 2,
    ) -> list[ProductRecommendation]:
        safe_candidates = [
            product for product in candidates if product.constraint_status != "violated"
        ]
        confident_candidates = [
            product
            for product in safe_candidates
            if product.constraint_status != "unknown_critical"
        ]
        if len(confident_candidates) >= minimum_confident_recommendations:
            return confident_candidates
        return safe_candidates
