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


def plan_search(rec: RecState, *, limit: int = 20) -> SearchPlan:
    markets = [code for code in rec.markets if code in VALID_MARKETS] or list(DEFAULT_MARKETS)
    query = (rec.query or "").strip()
    if rec.use_case and rec.use_case not in query:
        query = f"{query} {rec.use_case}".strip()
    precise = looks_like_exact_model(query)
    # BuyWhere keyword 对中文几乎不召回；hybrid 才能把「通勤降噪耳机」落到商品。
    mode = "keyword" if precise or not query_has_cjk(query) else "hybrid"
    return SearchPlan(
        query=query,
        markets=markets,
        mode=mode,
        limit=limit,
        budget_cny=rec.budget_cny,
        recall_mode="precise" if precise else "exploratory",
    )
