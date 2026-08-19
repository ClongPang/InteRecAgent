"""由 RecState 生成 SearchPlan。hybrid/semantic 只标记探索，主检索仍走 keyword。"""
from __future__ import annotations

import re

from ....domain.models import VALID_MARKETS
from ...dto.runner import SearchPlan
from .state import RecState

_MODEL_QUERY = re.compile(r"wh-?1000|qc\s*ultra|xm[45]|ultrawide|x ultra", re.I)


def looks_like_exact_model(query: str | None) -> bool:
    return bool(_MODEL_QUERY.search(query or ""))


def plan_search(rec: RecState, *, limit: int = 20) -> SearchPlan:
    markets = [code for code in rec.markets if code in VALID_MARKETS] or ["US"]
    query = (rec.query or "").strip()
    precise = looks_like_exact_model(query)
    return SearchPlan(
        query=query,
        markets=markets,
        mode="keyword",
        limit=limit,
        budget_cny=rec.budget_cny,
        recall_mode="precise" if precise else "exploratory",
    )
