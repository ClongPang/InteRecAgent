"""研究累加池：listing key 去重后并入，模型不得发明商品。"""
from __future__ import annotations

from ..application.services.rec.identity import expand_listing_keys, listing_keys_from_product
from ..domain.models import NormalizedProduct
from .tools.context import ResearchContext


def product_keys(product: NormalizedProduct) -> set[str]:
    return expand_listing_keys(listing_keys_from_product(product))


def ground_products(
    ids: list[str], allowed: list[NormalizedProduct]
) -> list[NormalizedProduct]:
    """只保留已有对象，按请求顺序；编造 / 重复 ID 丢掉。"""
    by_id = {item.id: item for item in allowed if item.id}
    seen: set[str] = set()
    out: list[NormalizedProduct] = []
    for raw in ids:
        key = str(raw).strip()
        if not key or key in seen or key not in by_id:
            continue
        seen.add(key)
        out.append(by_id[key])
    return out


def merge_into_pool(
    ctx: ResearchContext, batch: list[NormalizedProduct]
) -> tuple[int, int]:
    """把本轮留下的商品并入池子。返回 (新增件数, 去重件数)。"""
    existing: set[str] = set()
    for item in ctx.pool:
        existing |= product_keys(item)
    added = 0
    dupes = 0
    for item in batch:
        keys = product_keys(item)
        if keys & existing:
            dupes += 1
            continue
        ctx.pool.append(item)
        existing |= keys
        added += 1
    return added, dupes
