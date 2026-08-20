"""研究环测试：后端控环 + 累加池 + keep / TopK 求交。"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.agent.loop import run_agent, run_deterministic
from backend.agent.tools import ResearchContext, ResearchLimits, ResearchTools
from backend.application.dto import ProductSearchResult
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.errors import ModelUnavailableError
from backend.application.services.rec import plan_search, rec_state_from_mission
from backend.domain.models import NormalizedProduct
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.product_sources.fixture import FixtureProductSource
from tests.fakes import FakeModelBackend

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "buywhere"
OWNER = "cccccccc-cccc-cccc-cccc-cccccccccccc"

pytestmark = pytest.mark.unit


def _context(
    query: str,
    *,
    budget_cny: float | None = None,
    markets: list[str] | None = None,
    limits: ResearchLimits | None = None,
) -> ResearchContext:
    mission = ShoppingMission(
        owner_id=OWNER,
        title="研究循环测试",
        constraints=MissionConstraints(query=query, budget_cny=budget_cny, markets=markets or ["US"]),
    )
    plan = plan_search(rec_state_from_mission(mission))
    return ResearchContext(mission=mission, plan=plan, limits=limits or ResearchLimits())


def _tools() -> ResearchTools:
    return ResearchTools(FixtureProductSource(FIXTURES), FixedFxSource(), max_concurrency=3)


def _product(pid: str, title: str) -> NormalizedProduct:
    return NormalizedProduct(
        id=pid,
        title=title,
        merchant="shop",
        country_code="US",
        native_price_amount=40,
        native_currency="USD",
        rmb_price=280,
    )


class _ScriptedSource:
    def __init__(self, waves: list[list[NormalizedProduct]]) -> None:
        self.waves = waves
        self.calls = 0

    async def search(self, query, *, country_code, mode="keyword", limit=20, max_price=None):
        del query, mode, limit, max_price
        if country_code != "US":
            return ProductSearchResult(products=[])
        wave = self.waves[min(self.calls, len(self.waves) - 1)]
        self.calls += 1
        return ProductSearchResult(products=list(wave))

    async def get_product(self, product_id):
        del product_id
        return None


def _assert_traceable(ctx: ResearchContext) -> None:
    for product in ctx.ranked:
        assert product.id, "排序候选必须可溯源（有 id）"


def _assert_budget(ctx: ResearchContext, budget: float) -> None:
    for product in ctx.ranked:
        if product.fx_failed:
            continue
        assert product.rmb_price is not None and product.rmb_price <= budget, (
            f"预算被违反：{product.id} rmb={product.rmb_price} > {budget}"
        )


@pytest.mark.asyncio
async def test_deterministic_driver_produces_ranked() -> None:
    ctx = _context("索尼降噪耳机", markets=["US"])
    await run_deterministic(ctx, _tools())
    assert ctx.ranked, "确定性驱动应产出排序候选"
    assert ctx.converted
    _assert_traceable(ctx)


@pytest.mark.asyncio
async def test_deterministic_driver_respects_budget() -> None:
    ctx = _context("索尼降噪耳机", budget_cny=4000, markets=["US"])
    await run_deterministic(ctx, _tools())
    assert ctx.ranked
    _assert_budget(ctx, 4000)


@pytest.mark.asyncio
async def test_deterministic_driver_empties_when_all_over_budget() -> None:
    ctx = _context("索尼降噪耳机", budget_cny=3000, markets=["US"])
    await run_deterministic(ctx, _tools())
    assert ctx.ranked == []
    assert any("超出预算" in w for w in ctx.warnings)


@pytest.mark.asyncio
async def test_agent_keep_all_default_produces_ranked() -> None:
    ctx = _context("索尼降噪耳机", budget_cny=4000, markets=["US"])
    await run_agent(ctx, _tools(), FakeModelBackend())
    assert ctx.finalized
    assert ctx.ranked
    assert len(ctx.ranked) <= ctx.limits.top_k
    _assert_traceable(ctx)
    _assert_budget(ctx, 4000)


@pytest.mark.asyncio
async def test_deterministic_recovers_from_empty_market() -> None:
    ctx = _context("索尼降噪耳机", markets=["TH"])
    await run_deterministic(ctx, _tools())
    assert ctx.ranked, "扩大默认市场后应恢复出候选"
    _assert_traceable(ctx)


@pytest.mark.asyncio
async def test_agent_loop_falls_back_when_json_unavailable() -> None:
    class Boom(FakeModelBackend):
        async def complete_json(self, *, system: str, user: str):
            raise ModelUnavailableError("boom")

    ctx = _context("索尼降噪耳机", markets=["US"])
    await run_agent(ctx, _tools(), Boom())
    assert ctx.ranked, "模型 JSON 失败时应回退规则排序"
    _assert_traceable(ctx)


@pytest.mark.asyncio
async def test_keep_empty_does_not_merge_batch() -> None:
    wave = [_product("a", "Sony WH-1000XM5 Headphones"), _product("b", "Sony WH-CH720 Headphones")]
    tools = ResearchTools(_ScriptedSource([wave]), FixedFxSource())
    ctx = _context(
        "耳机",
        markets=["US"],
        limits=ResearchLimits(pool_threshold=25, max_searches=1, top_k=6),
    )
    backend = FakeModelBackend(json_replies=[{"keep": []}, {"ranked": ["a"]}])
    await run_agent(ctx, tools, backend)
    assert ctx.pool == []
    assert ctx.ranked == []


@pytest.mark.asyncio
async def test_keep_grounds_unknown_ids() -> None:
    wave = [_product("a", "Sony WH-1000XM5 Headphones"), _product("b", "Sony WH-CH720 Headphones")]
    tools = ResearchTools(_ScriptedSource([wave]), FixedFxSource())
    ctx = _context(
        "耳机",
        markets=["US"],
        limits=ResearchLimits(pool_threshold=25, max_searches=1, top_k=6),
    )
    backend = FakeModelBackend(json_replies=[{"keep": ["b", "ghost", "a"]}, {"ranked": ["ghost", "b"]}])
    await run_agent(ctx, tools, backend)
    assert [item.id for item in ctx.pool] == ["b", "a"]
    assert [item.id for item in ctx.ranked] == ["b"]


@pytest.mark.asyncio
async def test_pool_stops_when_threshold_reached() -> None:
    first = [_product(f"p{i}", f"Wireless Headphones {i}") for i in range(8)]
    second = [_product(f"q{i}", f"ANC Headset {i}") for i in range(8)]
    source = _ScriptedSource([first, second])
    tools = ResearchTools(source, FixedFxSource())
    ctx = _context(
        "耳机",
        markets=["US"],
        limits=ResearchLimits(pool_threshold=6, max_searches=3, top_k=6),
    )
    await run_agent(ctx, tools, FakeModelBackend())
    assert ctx.search_count == 1
    assert source.calls == 1
    assert len(ctx.pool) >= 6
    assert len(ctx.ranked) <= 6


@pytest.mark.asyncio
async def test_rewrite_merges_second_search() -> None:
    first = [_product("a", "Sony WH-1000XM5 Headphones")]
    second = [_product("c", "Bose QuietComfort Headphones")]
    source = _ScriptedSource([first, second])
    tools = ResearchTools(source, FixedFxSource())
    ctx = _context(
        "耳机",
        markets=["US"],
        limits=ResearchLimits(pool_threshold=25, max_searches=3, top_k=6),
    )
    backend = FakeModelBackend(
        json_replies=[
            {"keep": ["a"]},
            {"query": "bose qc"},
            {"keep": ["c"]},
            {"query": None},
            {"ranked": ["c", "a"]},
        ]
    )
    await run_agent(ctx, tools, backend)
    assert ctx.search_count == 2
    assert [item.id for item in ctx.pool] == ["a", "c"]
    assert [item.id for item in ctx.ranked] == ["c", "a"]
    assert ctx.rewritten_queries == ["bose qc"]
