"""由 RecState 生成 SearchPlan。精确型号走 keyword；中文探索检索走 hybrid。"""
from __future__ import annotations

import re

from ....domain.models import DEFAULT_MARKETS, VALID_MARKETS
from ...dto.runner import SearchPlan
from .state import RecState

_MODEL_QUERY = re.compile(r"wh-?1000|qc\s*ultra|xm[45]|ultrawide|x ultra", re.I)


def looks_like_exact_model(query: str | None) -> bool:
    return bool(_MODEL_QUERY.search(query or ""))


def query_has_cjk(query: str | None) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in query or "")


def _query_variants(
    query: str,
    *,
    precise: bool,
    item_type: str | None,
    brand: str | None,
) -> list[str]:
    variants = [query]
    if precise:
        return variants
    canonical = None
    if item_type == "monitor":
        size = re.search(r"(\d{2,3})\s*(?:英寸|寸|inch|\")", query, re.I)
        resolution = "4K " if re.search(r"\b4k\b|\buhd\b|2160|3840", query, re.I) else ""
        canonical = (
            f"{brand + ' ' if brand else ''}"
            f"{size.group(1) + ' inch ' if size else ''}{resolution}computer monitor"
        )
    elif item_type == "headphones" or re.search(r"耳机|降噪", query, re.I):
        canonical = (
            f"{brand + ' ' if brand else ''}"
            f"{'noise cancelling headphones' if '降噪' in query else 'headphones'}"
        )
    elif item_type == "smartphone" or re.search(r"手机|iPhone", query, re.I):
        canonical = (
            "Apple iPhone smartphone"
            if re.search(r"iphone", query, re.I)
            else f"{brand + ' ' if brand else ''}smartphone"
        )
    if canonical and query_has_cjk(query) and canonical.casefold() != query.casefold():
        variants = [canonical, query]
    elif canonical and canonical.casefold() != query.casefold():
        variants.append(canonical)
    elif query:
        variants.append(f"{query} product")
    return variants[:2]


def plan_search(rec: RecState, *, limit: int = 20) -> SearchPlan:
    markets = [code for code in rec.markets if code in VALID_MARKETS] or list(DEFAULT_MARKETS)
    query = (rec.query or "").strip()
    if rec.use_case and rec.use_case not in query:
        query = f"{query} {rec.use_case}".strip()
    if rec.merchants:
        token = rec.merchants[0]
        if token.lower() not in query.lower():
            query = f"{query} {token}".strip()
    precise = looks_like_exact_model(query)
    # BuyWhere keyword 对中文几乎不召回；hybrid 才能把「通勤降噪耳机」落到商品。
    mode = "keyword" if precise or not query_has_cjk(query) else "hybrid"
    variants = _query_variants(
        query,
        precise=precise,
        item_type=rec.item_type,
        brand=rec.brand,
    )
    if rec.merchants:
        merchant = rec.merchants[0]
        variants = [
            variant
            if merchant.casefold() in variant.casefold()
            else f"{variant} {merchant}"
            for variant in variants
        ]
    execution_query = variants[0] if variants else query
    if not query_has_cjk(execution_query):
        mode = "keyword"
    return SearchPlan(
        query=execution_query,
        query_variants=variants,
        markets=markets,
        mode=mode,
        limit=limit,
        budget_cny=rec.budget_cny,
        recall_mode="precise" if precise else "exploratory",
    )
