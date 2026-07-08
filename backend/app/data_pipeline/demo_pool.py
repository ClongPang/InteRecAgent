from __future__ import annotations

from backend.app.schemas import ProductRecommendation


def select_demo_pool(
    products: list[ProductRecommendation],
    limit: int = 50,
) -> list[ProductRecommendation]:
    def completeness(product: ProductRecommendation) -> tuple[int, float]:
        score = 0
        score += 1 if product.price is not None else 0
        score += 1 if product.image_url else 0
        score += 1 if product.brand else 0
        score += 1 if product.category_path else 0
        score += 1 if product.evidence else 0
        return score, product.average_rating or 0.0

    return sorted(products, key=completeness, reverse=True)[:limit]
