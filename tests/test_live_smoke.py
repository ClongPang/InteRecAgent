from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.adapters.buywhere import BuyWhereClient
from backend.adapters.fx import FrankfurterClient
from backend.domain.models import SearchMode, SearchParams
from backend.service import SearchService

REPO_ROOT = Path(__file__).resolve().parents[1]


def _api_key() -> str | None:
    for env in ("BuyWhere_API", "BUYWHERE_API_KEY"):
        if os.getenv(env):
            return os.environ[env]
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("BuyWhere_API="):
                return line.split("=", 1)[1].strip()
    return None


def _service() -> SearchService:
    key = _api_key()
    if not key:
        pytest.skip("未找到 BuyWhere_API，跳过真实冒烟")
    return SearchService(buywhere=BuyWhereClient(api_key=key), fx=FrankfurterClient())


@pytest.mark.live
def test_live_keyword_headphones():
    result = _service().run(
        SearchParams(query="sony wh1000xm5 headphones", markets=["US"], mode=SearchMode.KEYWORD, budget_cny=5000)
    )
    assert result.products
    # 汇率可用时每个保留商品都有人民币价；否则明确标记 fx_failed（不伪造）
    assert all(p.rmb_price is not None or p.fx_failed for p in result.products)
    print(f"live: {len(result.products)} 商品, warnings={result.warnings}")


@pytest.mark.live
def test_live_hybrid_monitors():
    result = _service().run(
        SearchParams(query="27 inch 4k monitor", markets=["US", "SG"], mode=SearchMode.HYBRID)
    )
    assert result.products
    print(f"live: {len(result.products)} 商品, fx_failed={sum(p.fx_failed for p in result.products)}")


@pytest.mark.live
def test_live_keyword_shoes():
    result = _service().run(
        SearchParams(query="salomon x ultra 4 gtx", markets=["US"], mode=SearchMode.KEYWORD)
    )
    assert result.products
    print(f"live: {len(result.products)} 商品, warnings={result.warnings}")
