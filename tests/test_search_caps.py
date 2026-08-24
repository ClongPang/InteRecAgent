"""原币预算上限与确定性召回放宽。"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.agent.loop import run_deterministic
from backend.agent.tools import ResearchContext, ResearchTools
from backend.application.dto import ProductSearchResult
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.rec import (
    native_budget_cap,
    plan_search,
    rec_state_from_mission,
)
from backend.domain.models import DEFAULT_MARKETS, NormalizedProduct
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.product_sources.fixture import FixtureProductSource

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "buywhere"
OWNER = "cccccccc-cccc-cccc-cccc-cccccccccccc"


def test_default_markets_are_us_and_sg() -> None:
    mission = ShoppingMission(owner_id=OWNER, title="t")
    assert list(mission.constraints.markets) == list(DEFAULT_MARKETS)
    plan = plan_search(rec_state_from_mission(mission))
    assert plan.markets == list(DEFAULT_MARKETS)


def test_native_budget_cap_divides_by_rate() -> None:
    assert native_budget_cap(2500, 7.1882) == round(2500 / 7.1882, 2)


@pytest.mark.asyncio
async def test_fixture_honors_native_max_price() -> None:
    src = FixtureProductSource(FIXTURES)
    full = await src.search("q", country_code="US", limit=20)
    capped = await src.search("q", country_code="US", limit=20, max_price=1.0)
    assert full.products
    assert capped.products == []


@pytest.mark.asyncio
async def test_deterministic_relaxes_native_cap_when_recall_empty() -> None:
    class CapThenFull:
        def __init__(self) -> None:
            self._inner = FixtureProductSource(FIXTURES)

        async def search(self, query, *, country_code, mode="keyword", limit=20, max_price=None):
            if max_price is not None:
                return ProductSearchResult(products=[])
            return await self._inner.search(
                query, country_code=country_code, mode=mode, limit=limit
            )

        async def get_product(self, product_id):
            return await self._inner.get_product(product_id)

    mission = ShoppingMission(
        owner_id=OWNER,
        title="t",
        constraints=MissionConstraints(query="索尼降噪耳机", budget_cny=4000, markets=["US"]),
    )
    ctx = ResearchContext(mission=mission, plan=plan_search(rec_state_from_mission(mission)))
    await run_deterministic(ctx, ResearchTools(CapThenFull(), FixedFxSource()))
    assert ctx.ranked
    assert ctx.relaxed_native_cap
    assert any("放宽检索" in item for item in ctx.warnings)
    for product in ctx.ranked:
        if not product.fx_failed:
            assert product.rmb_price is not None and product.rmb_price <= 4000


@pytest.mark.asyncio
async def test_evidence_fetch_preserves_budget_for_next_market_recall() -> None:
    source = FixtureProductSource(FIXTURES)
    mission = ShoppingMission(
        owner_id=OWNER,
        title="t",
        constraints=MissionConstraints(query="降噪耳机", markets=["US", "SG"]),
    )
    ctx = ResearchContext(mission=mission, plan=plan_search(rec_state_from_mission(mission)))
    ctx.request_count = 2
    ctx.evidence_candidates = {
        f"unknown-{index}": NormalizedProduct(
            id=f"unknown-{index}",
            title=f"Unknown Headphones {index}",
            native_price_amount=10,
            native_currency="USD",
        )
        for index in range(5)
    }

    await ResearchTools(source, FixedFxSource()).supplement_evidence(ctx)

    assert ctx.request_count == 4
    assert len(ctx.evidence_attempted_ids) == 2
    assert ctx.limits.max_total_requests - ctx.request_count == len(ctx.plan.markets)
