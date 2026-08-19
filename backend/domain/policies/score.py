"""可降级的多目标排序。缺特征时重新归一权重，不补 mock 分。"""
from __future__ import annotations

from collections.abc import Iterable

from ..models import NormalizedProduct

NOISE_CUES = ("降噪", "noise", "cancelling", "anc", "wh-1000", "wh1000", "xm5", "xm4", "qc ultra")
BATTERY_CUES = ("续航", "battery", "小时", "hours", "hrs")


def product_text(product: NormalizedProduct) -> str:
    attrs = " ".join((product.attrs or {}).values())
    return f"{product.title} {attrs}".lower()


def title_matches_preference(product: NormalizedProduct, preference: str) -> bool:
    text = product_text(product)
    if preference == "noise":
        return any(cue in text for cue in NOISE_CUES)
    if preference == "battery":
        return any(cue in text for cue in BATTERY_CUES)
    return False


def title_matches_soft(product: NormalizedProduct, attr: str) -> bool:
    if attr in {"price", "weight"}:
        return False
    attrs = product.attrs or {}
    if attrs.get(attr):
        return True
    needle = attr.lower()
    if needle in product_text(product):
        return True
    brand = (attrs.get("brand") or "").lower()
    return bool(brand) and brand == needle


def score_and_rank(
    products: Iterable[NormalizedProduct],
    *,
    budget_cny: float | None,
    rejected_source_ids: set[str] | None = None,
    preference: str = "balanced",
    soft_prefs: Iterable[tuple[str, str, str]] | None = None,
    price_sensitive: bool = False,
) -> list[NormalizedProduct]:
    rejected = rejected_source_ids or set()
    soft = list(soft_prefs or [])
    items = list(products)
    priced = [p.rmb_price for p in items if p.rmb_price is not None]
    lo, hi = (min(priced), max(priced)) if priced else (0.0, 0.0)
    want_lowest = preference == "lowest" or price_sensitive or _soft_price_lower(soft)

    def _score(product: NormalizedProduct) -> tuple:
        parts: list[tuple[float, float]] = []
        if budget_cny is not None and product.rmb_price is not None:
            parts.append((1.0 if product.rmb_price <= budget_cny else 0.2, 0.35))
        price_weight = 0.55 if want_lowest else 0.18 if preference in {"battery", "noise"} else 0.4
        if product.rmb_price is not None and hi > lo:
            parts.append((1.0 - (product.rmb_price - lo) / (hi - lo), price_weight))
        elif product.rmb_price is not None:
            parts.append((1.0, price_weight))
        if product.in_stock is not None:
            parts.append((1.0 if product.in_stock else 0.0, 0.15))
        if product.id in rejected:
            parts.append((0.0, 0.3))
        if preference in {"battery", "noise"}:
            hit = title_matches_preference(product, preference)
            parts.append((1.0 if hit else 0.15, 0.40))
        for attr, _direction, status in soft:
            if status != "active" or attr in {"price", "weight"}:
                continue
            parts.append((1.0 if title_matches_soft(product, attr) else 0.2, 0.2))
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


def _soft_price_lower(soft: list[tuple[str, str, str]]) -> bool:
    return any(attr == "price" and direction == "lower" and status == "active" for attr, direction, status in soft)
