from __future__ import annotations

from pathlib import Path

from backend.app.schemas import IntentState, ProductRecommendation
from backend.app.services.product_store import ProductStore
from backend.app.services.vector_index import (
    DeterministicVectorIndex,
    default_vector_index_artifact_path,
    intent_query_text,
)


class Retriever:
    def __init__(
        self,
        product_store: ProductStore,
        index_path: Path | str | None = None,
        load_default_index: bool = True,
    ) -> None:
        self._product_store = product_store
        self._index_path = Path(index_path) if index_path else default_vector_index_artifact_path()
        self._artifact_index: DeterministicVectorIndex | None = None
        self.index_source = "in_memory"
        if load_default_index and self._index_path.exists():
            try:
                self._artifact_index = DeterministicVectorIndex.from_artifact(self._index_path)
                self.index_source = str(self._index_path)
            except ValueError:
                self._artifact_index = None

    def retrieve(self, intent: IntentState, top_k: int = 10) -> list[ProductRecommendation]:
        products = self._product_store.list()
        index = self._artifact_index or DeterministicVectorIndex(products)
        hits = index.search(intent_query_text(intent), top_k=len(products))
        products_by_id = {product.product_id: product for product in products}
        products = [products_by_id[hit.product_id] for hit in hits if hit.product_id in products_by_id]
        if not products and self._artifact_index is not None:
            index = DeterministicVectorIndex(self._product_store.list())
            self.index_source = "in_memory_fallback"
            hits = index.search(intent_query_text(intent), top_k=len(products_by_id))
            products = [products_by_id[hit.product_id] for hit in hits if hit.product_id in products_by_id]
        category = intent.category.lower()
        if "headphone" in category:
            products = [product for product in products if "headphone" in product.title.lower()]
        elif "mouse" in category:
            products = [product for product in products if "mouse" in product.title.lower()]
        return products[:top_k]
