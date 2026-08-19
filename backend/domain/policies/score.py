"""可降级的多目标排序。缺特征时重新归一权重，不补 mock 分。"""
from __future__ import annotations

from collections.abc import Iterable

from ..models import NormalizedProduct


def score_and_rank(
    products: Iterable[NormalizedProduct],
    *,
    budget_cny: float | None,
    rejected_source_ids: set[str] | None = None,
) -> list[NormalizedProduct]:
    rejected = rejected_source_ids or set()
    items = list(products)
    priced = [p.rmb_price for p in items if p.rmb_price is not None]
    lo, hi = (min(priced), max(priced)) if priced else (0.0, 0.0)

    def _score(product: NormalizedProduct) -> tuple:
        parts: list[tuple[float, float]] = []
        if budget_cny is not None and product.rmb_price is not None:
            parts.append((1.0 if product.rmb_price <= budget_cny else 0.2, 0.35))
        if product.rmb_price is not None and hi > lo:
            parts.append((1.0 - (product.rmb_price - lo) / (hi - lo), 0.4))
        elif product.rmb_price is not None:
            parts.append((1.0, 0.4))
        if product.in_stock is not None:
            parts.append((1.0 if product.in_stock else 0.0, 0.15))
        if product.id in rejected:
            parts.append((0.0, 0.3))
        weight = sum(w for _s, w in parts) or 1.0
        overall = sum(score * w for score, w in parts) / weight
        return (
            product.id in rejected,
            product.fx_failed,
            -overall,
            product.rmb_price if product.rmb_price is not None else float("inf"),
            product.id,
        )

    return sorted(items, key=_score)
