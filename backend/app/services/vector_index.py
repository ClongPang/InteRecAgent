from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from backend.app.schemas import IntentState, ProductRecommendation


TOKEN_RE = re.compile(r"[a-z0-9]+")
DEFAULT_VECTOR_INDEX_ARTIFACT_PATH = Path("data/indexes/product_index.jsonl")


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


def default_vector_index_artifact_path() -> Path:
    configured_path = os.getenv("INTEREC_INDEX_PATH")
    return Path(configured_path) if configured_path else DEFAULT_VECTOR_INDEX_ARTIFACT_PATH


@dataclass(frozen=True)
class VectorIndexHit:
    product_id: str
    score: float


def product_index_row(product: ProductRecommendation) -> dict[str, object]:
    return {
        "product_id": product.product_id,
        "tokens": sorted(tokenize(product_embedding_text(product))),
    }


def load_vector_index_artifact(path: Path | str) -> dict[str, set[str]]:
    index_path = Path(path)
    vectors: dict[str, set[str]] = {}
    with index_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                product_id = str(row["product_id"])
                tokens = row["tokens"]
                if not isinstance(tokens, list):
                    raise ValueError("tokens must be a list")
                vectors[product_id] = {str(token) for token in tokens}
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise ValueError(f"Invalid vector index artifact at {index_path}:{line_number}") from exc
    return vectors


class DeterministicVectorIndex:
    def __init__(
        self,
        products: list[ProductRecommendation] | None = None,
        vectors: dict[str, set[str]] | None = None,
    ) -> None:
        if vectors is not None:
            self._vectors = vectors
        else:
            self._vectors = {
                product.product_id: tokenize(product_embedding_text(product))
                for product in products or []
            }
        self.product_count = len(self._vectors)

    @classmethod
    def from_artifact(cls, path: Path | str) -> "DeterministicVectorIndex":
        return cls(vectors=load_vector_index_artifact(path))

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
