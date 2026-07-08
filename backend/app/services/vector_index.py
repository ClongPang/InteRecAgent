from __future__ import annotations

import re
from dataclasses import dataclass

from backend.app.schemas import IntentState, ProductRecommendation


TOKEN_RE = re.compile(r"[a-z0-9]+")


def product_embedding_text(product: ProductRecommendation) -> str:
    fields = [
        product.title,
        product.brand or "",
        product.leaf_category or "",
        " ".join(product.category_path),
        " ".join(product.matched_tags),
        " ".join(item.text for item in product.evidence),
    ]
    return " ".join(field for field in fields if field)


def intent_query_text(intent: IntentState) -> str:
    fields = [
        intent.category,
        intent.goal,
        intent.scenario,
        " ".join(intent.soft_preferences),
        " ".join(intent.priority_order),
    ]
    if intent.budget and intent.budget.max is not None:
        fields.append(f"under {int(intent.budget.max)} {intent.budget.currency}")
    return " ".join(field for field in fields if field)


def tokenize(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


@dataclass(frozen=True)
class VectorIndexHit:
    product_id: str
    score: float


class DeterministicVectorIndex:
    def __init__(self, products: list[ProductRecommendation]) -> None:
        self._vectors = {
            product.product_id: tokenize(product_embedding_text(product))
            for product in products
        }

    def search(self, query: str, top_k: int = 10) -> list[VectorIndexHit]:
        query_tokens = tokenize(query)
        hits = [
            VectorIndexHit(product_id=product_id, score=self._score(query_tokens, tokens))
            for product_id, tokens in self._vectors.items()
        ]
        hits.sort(key=lambda hit: (-hit.score, hit.product_id))
        return hits[:top_k]

    def _score(self, query_tokens: set[str], product_tokens: set[str]) -> float:
        if not query_tokens or not product_tokens:
            return 0.0
        overlap = len(query_tokens & product_tokens)
        union = len(query_tokens | product_tokens)
        return round(overlap / union, 6)
