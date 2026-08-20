"""被否定候选的稳定身份。快照 ID 在重搜后会变，listing key 用来跨轮对齐。"""
from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import parse_qs, unquote, urlparse

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
        page = page_key(url)
        if page:
            keys.append(page)
    title_n = " ".join((title or "").lower().split())
    merch = (merchant or "").strip().lower()
    if title_n:
        keys.append(f"title:{title_n}")
        keys.append(f"title:{title_n}|m:{merch}")
    return keys


def _unwrap_click(url: str | None) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower()
    if "buywhere." in host and parsed.path.startswith("/api/click"):
        inner = parse_qs(parsed.query).get("url", [None])[0]
        return unquote(inner) if inner else ""
    return raw


def unwrap_merchant_url(url: str | None) -> str | None:
    """用户跳转必须是商户 PDP。BuyWhere /api/click 在浏览器里 403，不能当外链。"""
    raw = _unwrap_click(url)
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower()
    if parsed.scheme != "https" or not host or "buywhere." in host:
        return None
    return raw


def page_key(url: str | None) -> str | None:
    """BuyWhere 会换 click 包装与 product_id；商户商品页路径才是同一条 listing。"""
    raw = _unwrap_click(url) or (url or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower()
    if not host:
        return None
    if host.startswith("www."):
        host = host[4:]
    path = (parsed.path or "").rstrip("/").lower()
    return f"page:{host}{path}" if path else None


def merchant_page_url(*candidates: str | None) -> str | None:
    for raw in candidates:
        page = unwrap_merchant_url(raw)
        if page:
            return page
    return None


def expand_listing_keys(keys: Iterable[str]) -> set[str]:
    """旧批评只存了 click URL / 带商家 slug 的标题时，补齐可对齐的稳定键。"""
    out: set[str] = set()
    for key in keys:
        if not key:
            continue
        out.add(key)
        if key.startswith("url:"):
            page = page_key(key[4:])
            if page:
                out.add(page)
        if key.startswith("title:") and "|m:" in key:
            out.add(key.split("|m:", 1)[0])
    return out


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
