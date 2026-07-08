from __future__ import annotations

from backend.app.schemas import ClaimEvidenceRecord, IntentState, ProductRecommendation


class GroundedResponseGenerator:
    def generate(
        self,
        intent: IntentState,
        products: list[ProductRecommendation],
        feedback_update: dict[str, object] | None = None,
    ) -> tuple[str, list[ProductRecommendation], list[ClaimEvidenceRecord]]:
        all_claims: list[ClaimEvidenceRecord] = []
        enriched_products: list[ProductRecommendation] = []
        for product in products:
            next_product = product.model_copy(deep=True)
            claims = self._claims_for_product(next_product)
            next_product.claim_evidence = claims
            all_claims.extend(claims)
            enriched_products.append(next_product)

        if feedback_update:
            message = "I updated the recommendations using your feedback and kept only catalog-backed claims."
        elif intent.category:
            message = f"I found catalog-backed recommendations for {intent.category}."
        else:
            message = "I found catalog-backed recommendations."
        return message, enriched_products, all_claims

    def _claims_for_product(self, product: ProductRecommendation) -> list[ClaimEvidenceRecord]:
        claims: list[ClaimEvidenceRecord] = []
        if product.price is not None:
            claims.append(
                ClaimEvidenceRecord(
                    claim=f"{product.title} has catalog price {product.currency} {product.price:.2f}.",
                    product_id=product.product_id,
                    evidence_type="metadata",
                    evidence_text=f"price={product.price}",
                    supported=True,
                )
            )
        else:
            claims.append(
                ClaimEvidenceRecord(
                    claim=f"{product.title} has unknown catalog price.",
                    product_id=product.product_id,
                    evidence_type="unknown",
                    evidence_text=None,
                    supported=False,
                )
            )
        if product.evidence:
            first_evidence = product.evidence[0]
            claims.append(
                ClaimEvidenceRecord(
                    claim=f"{product.title} has supporting {first_evidence.source} evidence.",
                    product_id=product.product_id,
                    evidence_type=first_evidence.source,
                    evidence_text=first_evidence.text,
                    supported=True,
                )
            )
        else:
            claims.append(
                ClaimEvidenceRecord(
                    claim=f"{product.title} has no review evidence in the loaded catalog.",
                    product_id=product.product_id,
                    evidence_type="unknown",
                    evidence_text=None,
                    supported=False,
                )
            )
        return claims
