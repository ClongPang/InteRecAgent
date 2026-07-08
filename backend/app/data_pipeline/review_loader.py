from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from backend.app.data_pipeline.metadata_loader import iter_jsonl
from backend.app.schemas import EvidenceItem, ProductRecommendation


def load_review_evidence(path: Path, max_snippets_per_product: int = 2) -> dict[str, list[EvidenceItem]]:
    evidence_by_product: dict[str, list[EvidenceItem]] = defaultdict(list)
    return load_filtered_review_evidence(path, None, max_snippets_per_product)


def load_filtered_review_evidence(
    path: Path,
    product_ids: set[str] | None,
    max_snippets_per_product: int = 2,
) -> dict[str, list[EvidenceItem]]:
    evidence_by_product: dict[str, list[EvidenceItem]] = defaultdict(list)
    for row in iter_jsonl(path):
        product_id = str(row.get("asin") or row.get("product_id") or "").strip()
        if product_ids is not None and product_id not in product_ids:
            continue
        text = str(row.get("reviewText") or row.get("text") or "").strip()
        if not product_id or not text:
            continue
        snippets = evidence_by_product[product_id]
        if len(snippets) < max_snippets_per_product:
            snippets.append(
                EvidenceItem(
                    source="review",
                    product_id=product_id,
                    text=text[:240],
                )
            )
    return dict(evidence_by_product)


def attach_review_evidence(
    products: list[ProductRecommendation],
    evidence_by_product: dict[str, list[EvidenceItem]],
) -> list[ProductRecommendation]:
    enriched: list[ProductRecommendation] = []
    for product in products:
        next_product = product.model_copy(deep=True)
        review_evidence = evidence_by_product.get(product.product_id, [])
        next_product.evidence = [*next_product.evidence, *review_evidence]
        uncertainties = set(next_product.uncertainties)
        if not review_evidence:
            uncertainties.add("review evidence missing")
        else:
            uncertainties.discard("review evidence missing")
        next_product.uncertainties = sorted(uncertainties)
        enriched.append(next_product)
    return enriched
