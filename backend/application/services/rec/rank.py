"""信念约束下的排序封装。领域 score_and_rank 只收原始元组。"""
from __future__ import annotations

from collections.abc import Iterable

from ....domain.models import NormalizedProduct
from ....domain.policies.score import score_and_rank, title_matches_preference
from .state import RecState


def rank_with_belief(
    products: Iterable[NormalizedProduct],
    rec: RecState,
    *,
    rejected_source_ids: set[str] | None = None,
) -> list[NormalizedProduct]:
    return score_and_rank(
        products,
        budget_cny=rec.budget_cny,
        rejected_source_ids=rejected_source_ids,
        preference=rec.preference,
        soft_prefs=rec.soft_prefs,
        price_sensitive=rec.price_sensitivity in {"too_expensive", "want_cheaper"},
    )


def preference_hits(products: Iterable[NormalizedProduct], preference: str) -> int:
    if preference not in {"battery", "noise"}:
        return 0
    return sum(1 for product in products if title_matches_preference(product, preference))
