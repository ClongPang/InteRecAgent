from __future__ import annotations

from backend.app.schemas import IntentState, ProductRecommendation
from backend.app.services.product_store import ProductStore
from backend.app.services.vector_index import DeterministicVectorIndex, intent_query_text


class Retriever:
    def __init__(self, product_store: ProductStore) -> None:
        self._product_store = product_store

    def retrieve(self, intent: IntentState, top_k: int = 10) -> list[ProductRecommendation]:
        products = self._product_store.list()
        index = DeterministicVectorIndex(products)
        hits = index.search(intent_query_text(intent), top_k=len(products))
        products_by_id = {product.product_id: product for product in products}
        products = [products_by_id[hit.product_id] for hit in hits if hit.product_id in products_by_id]
        category = intent.category.lower()
        if "headphone" in category:
            products = [product for product in products if "headphone" in product.title.lower()]
        elif "mouse" in category:
            products = [product for product in products if "mouse" in product.title.lower()]
        return products[:top_k]
