"""被否定候选的稳定身份。快照 ID 在重搜后会变，listing key 用来跨轮对齐。"""
from __future__ import annotations

from ....domain.models import NormalizedProduct


def listing_keys_of(
    *,
    source_id: str | None = None,
    title: str | None = None,
    merchant: str | None = None,
    url: str | None = None,
    snapshot_id: str | None = None,
) -> list[str]:
    keys: list[str] = []
    if snapshot_id:
        keys.append(f"snap:{snapshot_id}")
    if source_id:
        keys.append(f"src:{source_id}")
    if url:
        keys.append(f"url:{url.rstrip('/').lower()}")
    title_n = " ".join((title or "").lower().split())
    merch = (merchant or "").strip().lower()
    if title_n:
        keys.append(f"title:{title_n}|m:{merch}")
    return keys


def listing_keys_from_record(item: dict | None) -> list[str]:
    if not item:
        return []
    return listing_keys_of(
        source_id=str(item.get("source_product_id") or item.get("id") or "") or None,
        title=item.get("title"),
        merchant=item.get("merchant"),
        url=item.get("merchant_url") or item.get("url") or item.get("click_url"),
        snapshot_id=item.get("snapshot_id"),
    )


def listing_keys_from_product(
    product: NormalizedProduct, *, snapshot_id: str | None = None
) -> list[str]:
    return listing_keys_of(
        source_id=product.id,
        title=product.title,
        merchant=product.merchant,
        url=product.click_url or product.url,
        snapshot_id=snapshot_id,
    )


def record_for_snapshot(ranked: list[dict], snapshot_id: str | None) -> dict | None:
    if snapshot_id:
        for item in ranked:
            if item.get("snapshot_id") == snapshot_id:
                return item
    return ranked[0] if ranked else None
