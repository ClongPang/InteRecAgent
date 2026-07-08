from __future__ import annotations

from backend.app.schemas import ProductRecommendation


def build_quality_report(products: list[ProductRecommendation]) -> dict[str, float | int]:
    total = len(products)
    if total == 0:
        return {
            "product_count": 0,
            "price_coverage": 0.0,
            "image_coverage": 0.0,
            "brand_coverage": 0.0,
            "category_coverage": 0.0,
            "evidence_coverage": 0.0,
        }

    def coverage(predicate) -> float:
        return round(sum(1 for product in products if predicate(product)) / total, 4)

    return {
        "product_count": total,
        "price_coverage": coverage(lambda product: product.price is not None),
        "image_coverage": coverage(lambda product: bool(product.image_url)),
        "brand_coverage": coverage(lambda product: bool(product.brand)),
        "category_coverage": coverage(lambda product: bool(product.category_path)),
        "evidence_coverage": coverage(lambda product: bool(product.evidence)),
    }
