from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.application.services import SearchService
from backend.domain.models import SearchMode, SearchParams
from backend.infrastructure.fx_sources.frankfurter import FrankfurterFxSource
from backend.infrastructure.product_sources.buywhere import BuyWhereProductSource

REPO_ROOT = Path(__file__).resolve().parents[1]

pytestmark = [pytest.mark.live, pytest.mark.asyncio]


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


async def _run(query: str, markets: list[str], mode: SearchMode, budget: float | None = None):
    key = _api_key()
    if not key:
        pytest.skip("未找到 BuyWhere_API，跳过真实冒烟")
    async with BuyWhereProductSource(api_key=key) as buywhere, FrankfurterFxSource() as fx:
        service = SearchService(products=buywhere, fx=fx)
        return await service.run(
            SearchParams(query=query, markets=markets, mode=mode, budget_cny=budget)
        )


async def test_live_keyword_headphones():
    result = await _run("sony wh1000xm5 headphones", ["US"], SearchMode.KEYWORD, 5000)
    assert result.products
    # 汇率可用时每个保留商品都有人民币价；否则明确标记 fx_failed（不伪造）
    assert all(p.rmb_price is not None or p.fx_failed for p in result.products)
    print(f"live: {len(result.products)} 商品, warnings={result.warnings}")


async def test_live_hybrid_monitors():
    result = await _run("27 inch 4k monitor", ["US", "SG"], SearchMode.HYBRID)
    assert result.products
    print(f"live: {len(result.products)} 商品, fx_failed={sum(p.fx_failed for p in result.products)}")


async def test_live_keyword_shoes():
    result = await _run("salomon x ultra 4 gtx", ["US"], SearchMode.KEYWORD)
    assert result.products
    print(f"live: {len(result.products)} 商品, warnings={result.warnings}")
