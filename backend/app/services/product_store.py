from __future__ import annotations

from backend.app.schemas import EvidenceItem, ProductRecommendation


CATALOG_PRODUCTS = [
    ProductRecommendation(
        product_id="prod_headphones_001",
        title="AeroLite Wireless Commuter Headphones",
        brand="AeroLite",
        price=79.99,
        image_url=None,
        category_path=["Electronics", "Headphones", "Wireless"],
        leaf_category="Wireless Headphones",
        average_rating=4.4,
        review_count=824,
        matched_tags=["commuting", "comfortable"],
        evidence=[
            EvidenceItem(
                source="review",
                product_id="prod_headphones_001",
                text="Reviewers repeatedly mention light weight and comfortable long-wear fit.",
            )
        ],
        uncertainties=["Battery life varies by listening volume."],
        rank_reason=None,
        rank=0,
    ),
    ProductRecommendation(
        product_id="prod_headphones_002",
        title="MetroBeat Compact Wireless Headphones",
        brand="MetroBeat",
        price=None,
        image_url=None,
        category_path=["Electronics", "Headphones", "Wireless"],
        leaf_category="Wireless Headphones",
        average_rating=4.1,
        review_count=311,
        matched_tags=["compact", "portable"],
        evidence=[],
        uncertainties=["price unknown", "review evidence missing"],
        rank_reason=None,
        rank=0,
    ),
    ProductRecommendation(
        product_id="prod_headphones_003",
        title="StudioMax Premium Wireless Headphones",
        brand="StudioMax",
        price=149.99,
        image_url=None,
        category_path=["Electronics", "Headphones", "Wireless"],
        leaf_category="Wireless Headphones",
        average_rating=4.7,
        review_count=1208,
        matched_tags=["battery", "premium sound"],
        evidence=[
            EvidenceItem(
                source="metadata",
                product_id="prod_headphones_003",
                text="Catalog metadata lists extended battery mode and premium audio drivers.",
            )
        ],
        uncertainties=[],
        rank_reason=None,
        rank=0,
    ),
    ProductRecommendation(
        product_id="prod_mouse_001",
        title="QuietPro Wireless Office Mouse",
        brand="QuietPro",
        price=34.5,
        image_url=None,
        category_path=["Electronics", "Computer Accessories", "Mouse"],
        leaf_category="Wireless Mouse",
        average_rating=4.3,
        review_count=463,
        matched_tags=["quiet click", "office"],
        evidence=[
            EvidenceItem(
                source="review",
                product_id="prod_mouse_001",
                text="Reviews mention quiet clicks and reliable office use.",
            )
        ],
        uncertainties=[],
        rank_reason=None,
        rank=0,
    ),
]


class ProductStore:
    def __init__(self, products: list[ProductRecommendation] | None = None) -> None:
        self._products = products or CATALOG_PRODUCTS

    def get(self, product_id: str) -> ProductRecommendation | None:
        for product in self._products:
            if product.product_id == product_id:
                return product.model_copy(deep=True)
        return None

    def list(self) -> list[ProductRecommendation]:
        return [product.model_copy(deep=True) for product in self._products]
