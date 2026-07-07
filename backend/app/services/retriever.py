from __future__ import annotations

from backend.app.schemas import IntentState, ProductRecommendation
from backend.app.services.product_store import ProductStore


class Retriever:
    def __init__(self, product_store: ProductStore) -> None:
        self._product_store = product_store

    def retrieve(self, intent: IntentState, top_k: int = 10) -> list[ProductRecommendation]:
        products = self._product_store.list()
        category = intent.category.lower()
        if "headphone" in category:
            products = [product for product in products if "headphone" in product.title.lower()]
        elif "mouse" in category:
            products = [product for product in products if "mouse" in product.title.lower()]
        return products[:top_k]
