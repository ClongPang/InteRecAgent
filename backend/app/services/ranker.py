from __future__ import annotations

from backend.app.schemas import IntentState, ProductRecommendation


class RuleRanker:
    def rank(self, candidates: list[ProductRecommendation], intent: IntentState) -> list[ProductRecommendation]:
        ranked = []
        for product in candidates:
            intent_match = self._intent_match(product, intent)
            price_fit = self._price_fit(product, intent)
            evidence = min(1.0, len(product.evidence) * 0.4 + (0.2 if product.average_rating else 0.0))
            uncertainty_penalty = 0.2 * len(product.uncertainties)
            score = intent_match + price_fit + evidence - uncertainty_penalty
            product.score_breakdown = {
                "intent_match": round(intent_match, 3),
                "price_fit": round(price_fit, 3),
                "evidence": round(evidence, 3),
                "uncertainty_penalty": round(uncertainty_penalty, 3),
                "total": round(score, 3),
            }
            product.rank_reason = self._rank_reason(product)
            ranked.append(product)
        ranked.sort(key=lambda item: item.score_breakdown["total"], reverse=True)
        for index, product in enumerate(ranked, start=1):
            product.rank = index
        return ranked

    def _intent_match(self, product: ProductRecommendation, intent: IntentState) -> float:
        haystack = " ".join([product.title, product.leaf_category or "", *product.matched_tags]).lower()
        score = 0.4
        for token in [intent.category, intent.goal, *intent.soft_preferences, *intent.priority_order]:
            if token and token.lower() in haystack:
                score += 0.15
        return min(score, 1.0)

    def _price_fit(self, product: ProductRecommendation, intent: IntentState) -> float:
        if not intent.budget or intent.budget.max is None:
            return 0.5
        if product.price is None:
            return 0.0
        if product.price <= intent.budget.max:
            return 1.0 - (product.price / intent.budget.max) * 0.2
        return -1.0

    def _rank_reason(self, product: ProductRecommendation) -> str:
        if product.constraint_status == "unknown":
            return "Close match, but some required facts are unknown."
        return "Ranked by intent match, price fit, and available evidence."
