from __future__ import annotations

from backend.app.schemas import IntentState, ProductRecommendation
from backend.app.services.llm_adapter import LLMAdapter, LLMAdapterError, RerankPlan


class LLMReranker:
    def __init__(self, adapter: LLMAdapter | None = None) -> None:
        self.adapter = adapter or LLMAdapter(mode="mock")

    def rerank(
        self,
        candidates: list[ProductRecommendation],
        intent: IntentState,
    ) -> tuple[list[ProductRecommendation], dict[str, object]]:
        safe_candidates = [product for product in candidates if product.constraint_status != "violated"]
        candidate_ids = [product.product_id for product in safe_candidates]
        prompt = f"intent={intent.model_dump()} candidates={candidate_ids}"
        try:
            plan = self.adapter.generate_json(prompt, RerankPlan)
        except LLMAdapterError:
            return safe_candidates, {
                "mode": self.adapter.mode,
                "changed_order": False,
                "fallback": "rule_ranker",
            }
        order = [product_id for product_id in plan.ordered_product_ids if product_id in candidate_ids]
        ordered_lookup = {product.product_id: product for product in safe_candidates}
        reranked = [ordered_lookup[product_id] for product_id in order]
        reranked.extend(product for product in safe_candidates if product.product_id not in order)
        changed_order = [product.product_id for product in reranked] != candidate_ids
        for index, product in enumerate(reranked, start=1):
            product.rank = index
        return reranked, {
            "mode": self.adapter.mode,
            "changed_order": changed_order,
            "rationale": plan.rationale,
            "input_item_ids": candidate_ids,
            "output_item_ids": [product.product_id for product in reranked],
        }
