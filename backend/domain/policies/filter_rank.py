from __future__ import annotations

import re
from collections.abc import Iterable

from ..models import FxSnapshot, NormalizedProduct


def convert_products(
    products: Iterable[NormalizedProduct], rates: dict[str, FxSnapshot]
) -> list[NormalizedProduct]:
    """按 rates[currency] 换算人民币价。缺少某币种汇率时该商品 fx_failed=True（保留原币）。"""
    out: list[NormalizedProduct] = []
    for p in products:
        snap = rates.get(p.native_currency)
        if snap is not None:
            out.append(
                p.model_copy(
                    update={
                        "rmb_price": round(p.native_price_amount * snap.rate, 2),
                        "fx_as_of": snap.date,
                    }
                )
            )
        else:
            out.append(p.model_copy(update={"fx_failed": True}))
    return out


def apply_stock_filter(
    products: Iterable[NormalizedProduct],
) -> tuple[list[NormalizedProduct], list[NormalizedProduct], list[NormalizedProduct]]:
    """仅在至少一件商品有库存事实时过滤。全未知则不筛，避免 fixture 被清空。"""
    items = list(products)
    if not any(p.in_stock is not None for p in items):
        return items, [], []
    kept = [p for p in items if p.in_stock is True]
    unknown = [p for p in items if p.in_stock is None]
    out = [p for p in items if p.in_stock is False]
    return kept, out, unknown


_CATEGORY_CUES: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    (("显示器", "屏幕", "monitor", "display"), ("monitor", "display", "显示器", "屏幕")),
    (
        ("耳机", "headphone", "earbuds", "earbud", "降噪"),
        ("headphone", "headset", "earbuds", "earbud", "earphones", "耳机", "anc", "降噪"),
    ),
    (("徒步鞋", "登山鞋"), ("hiking", "trek", "徒步", "trail")),
    (("运动鞋", "跑鞋"), ("running", "athletic", "sneaker", "跑鞋", "运动鞋")),
    (("鞋", "shoe"), ("shoe", "boot", "sneaker", "trainer", "sandal", "hiking", "鞋")),
)


def relevance_cues(query: str | None) -> tuple[str, ...]:
    text = (query or "").lower()
    if not text:
        return ()
    for hints, cues in _CATEGORY_CUES:
        if any(hint in text for hint in hints):
            return cues
    return ()


def apply_relevance_filter(
    products: Iterable[NormalizedProduct], query: str | None
) -> tuple[list[NormalizedProduct], list[NormalizedProduct]]:
    """标题与品类对不上的召回先丢掉；若会清空则原样返回，避免假空集。"""
    items = list(products)
    cues = relevance_cues(query)
    if not cues:
        return items, []
    kept: list[NormalizedProduct] = []
    dropped: list[NormalizedProduct] = []
    for product in items:
        title = (product.title or "").lower()
        if any(cue in title for cue in cues):
            kept.append(product)
        else:
            dropped.append(product)
    if not kept:
        return items, []
    return kept, dropped


def apply_exclusion_filter(
    products: Iterable[NormalizedProduct], terms: list[str]
) -> tuple[list[NormalizedProduct], list[NormalizedProduct]]:
    """标题包含排除词则去掉。无品牌字段时只能用标题子串，不得编造品牌。"""
    needles = [t.lower() for t in terms if t and t.strip()]
    if not needles:
        return list(products), []
    kept: list[NormalizedProduct] = []
    dropped: list[NormalizedProduct] = []
    for p in products:
        title = p.title.lower()
        if any(term in title for term in needles):
            dropped.append(p)
        else:
            kept.append(p)
    return kept, dropped


def apply_budget_filter(
    products: Iterable[NormalizedProduct], budget_cny: float
) -> tuple[list[NormalizedProduct], list[NormalizedProduct], list[NormalizedProduct]]:
    """预算硬过滤。返回 (保留, 超预算排除, 换算失败保留)。换算失败的商品不因预算排除，
    遵循"部分成功是正常结果"原则——但排序时置于最后。"""
    kept: list[NormalizedProduct] = []
    over: list[NormalizedProduct] = []
    fx_failed: list[NormalizedProduct] = []
    for p in products:
        if p.fx_failed:
            fx_failed.append(p)
        elif p.rmb_price is not None and p.rmb_price <= budget_cny:
            kept.append(p)
        else:
            over.append(p)
    return kept, over, fx_failed


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "", title.lower())


def dedupe_products(products: Iterable[NormalizedProduct]) -> list[NormalizedProduct]:
    """同 merchant + 归一化 title 去重，保留第一次出现。"""
    seen: set[tuple[str | None, str]] = set()
    out: list[NormalizedProduct] = []
    for p in products:
        key = (p.merchant, _title_key(p.title))
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def rank_products(products: Iterable[NormalizedProduct]) -> list[NormalizedProduct]:
    """默认人民币价升序；换算失败排最后。以 updated_at 新→旧、id 保证同价下确定性。"""
    return sorted(
        products,
        key=lambda p: (
            p.fx_failed,
            p.rmb_price if p.rmb_price is not None else float("inf"),
            -(p.updated_at.timestamp() if p.updated_at else 0.0),
            p.id,
        ),
    )
