"""可降级的多目标排序。缺特征时重新归一权重，不补 mock 分。"""
from __future__ import annotations

from collections.abc import Iterable

from ..models import NormalizedProduct

NOISE_CUES = ("降噪", "noise", "cancelling", "anc", "wh-1000", "wh1000", "xm5", "xm4", "qc ultra")
BATTERY_CUES = ("续航", "battery", "小时", "hours", "hrs")

# 遗留 preference 枚举的种子线索。仅作确定性 fallback 的默认同义词；
# LLM 产出的开放式软偏好自带 cues，不依赖此表——这样新增偏好维度是「给数据」而非「改分支」。
SEED_CUES: dict[str, tuple[str, ...]] = {"noise": NOISE_CUES, "battery": BATTERY_CUES}


def product_text(product: NormalizedProduct) -> str:
    attrs = " ".join((product.attrs or {}).values())
    return f"{product.title} {attrs}".lower()


def dimension_matches(
    product: NormalizedProduct, *, attr: str, cues: Iterable[str] = ()
) -> bool:
    """通用维度命中：结构化 attr 字段 > cues/attr 名称的标题命中 > 品牌命中。

    价格/重量走各自专门通道（价格权重、无规格降级），不在此判定。"""
    if attr in {"price", "weight"}:
        return False
    attrs = product.attrs or {}
    if attrs.get(attr):
        return True
    text = product_text(product)
    needles = [attr.lower(), *(cue.lower() for cue in cues)]
    if any(needle and needle in text for needle in needles):
        return True
    brand = (attrs.get("brand") or "").lower()
    return bool(brand) and brand == attr.lower()


def title_matches_preference(product: NormalizedProduct, preference: str) -> bool:
    cues = SEED_CUES.get(preference)
    if cues is None:
        return False
    return dimension_matches(product, attr=preference, cues=cues)


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
        price_weight = 0.55 if want_lowest else 0.18 if preference in SEED_CUES else 0.4
        if product.rmb_price is not None and hi > lo:
            parts.append((1.0 - (product.rmb_price - lo) / (hi - lo), price_weight))
        elif product.rmb_price is not None:
            parts.append((1.0, price_weight))
        if product.in_stock is not None:
            parts.append((1.0 if product.in_stock else 0.0, 0.15))
        if product.id in rejected:
            parts.append((0.0, 0.3))
        if preference in SEED_CUES:
            hit = title_matches_preference(product, preference)
            parts.append((1.0 if hit else 0.15, 0.40))
        for entry in soft:
            attr, _direction, status = entry[0], entry[1], entry[2]
            cues = entry[3] if len(entry) > 3 else ()
            if status != "active" or attr in {"price", "weight"}:
                continue
            hit = dimension_matches(product, attr=attr, cues=cues)
            parts.append((1.0 if hit else 0.2, 0.2))
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


def _soft_price_lower(soft: list[tuple]) -> bool:
    return any(
        entry[0] == "price" and entry[1] == "lower" and entry[2] == "active"
        for entry in soft
    )
