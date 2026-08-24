"""研究环测试：后端控环 + 累加池 + keep / TopK 求交。"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.agent.judges import shadow_semantic_profiles
from backend.agent.loop import run_agent, run_deterministic
from backend.agent.tools import ResearchContext, ResearchLimits, ResearchTools
from backend.application.dto import (
    GoalConstraint,
    GoalTarget,
    ProductSearchResult,
    RetrievalScope,
    ShoppingGoal,
)
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


class _DetailSource(_ScriptedSource):
    def __init__(self, waves, details):
        super().__init__(waves)
        self.details = details
        self.detail_calls: list[str] = []

    async def get_product(self, product_id):
        self.detail_calls.append(product_id)
        return self.details.get(product_id)


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
    assert ctx.pool, "模型不可用时，资格门通过的候选仍应进入可行集"


@pytest.mark.asyncio
async def test_semantic_model_proposals_are_recorded_as_shadow_only() -> None:
    class SemanticBackend(FakeModelBackend):
        async def complete_json(self, *, system: str, user: str):
            del system, user
            return {
                "profiles": [
                    {
                        "id": "a",
                        "item_type": "headphones",
                        "relation": "product",
                        "confidence": 0.97,
                        "evidence_spans": ["Headphones"],
                    }
                ]
            }

    item = _product("a", "Sony WH-1000XM5 Headphones")
    ctx = _context("耳机", markets=["US"])
    await shadow_semantic_profiles(SemanticBackend(), ctx, [item])
    assert ctx.semantic_profile_proposals["a"]["method"] == "model"
    shadow = ctx.semantic_profile_shadow["a"]
    assert shadow["adjudicated"]["method"] == "adjudicated"
    assert shadow["guard"]["method"] == "rule"
    assert ctx.products == []  # shadow analysis cannot change the active candidate bus


@pytest.mark.asyncio
async def test_keep_empty_cannot_erase_qualified_batch() -> None:
    wave = [_product("a", "Sony WH-1000XM5 Headphones"), _product("b", "Sony WH-CH720 Headphones")]
    tools = ResearchTools(_ScriptedSource([wave]), FixedFxSource())
    ctx = _context(
        "耳机",
        markets=["US"],
        limits=ResearchLimits(pool_threshold=25, max_searches=1, top_k=6),
    )
    backend = FakeModelBackend(json_replies=[{"keep": []}, {"ranked": ["a"]}])
    await run_agent(ctx, tools, backend)
    assert [item.id for item in ctx.pool] == ["a", "b"]
    assert [item.id for item in ctx.ranked] == ["a", "b"]


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
    assert [item.id for item in ctx.ranked] == ["a", "b"]


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
    assert [item.id for item in ctx.ranked] == ["a", "c"]
    assert ctx.rewritten_queries == ["bose qc"]


@pytest.mark.asyncio
async def test_model_and_token_budgets_are_hard_limits() -> None:
    source = _ScriptedSource([[_product("a", "Sony Headphones")]])
    limits = ResearchLimits(
        max_searches=2,
        max_model_calls=1,
        max_estimated_tokens=2_000,
    )
    ctx = _context("headphones", markets=["US"], limits=limits)
    backend = FakeModelBackend(json_replies=[{"keep": ["a"]}, {"query": "sony"}])
    await run_agent(ctx, ResearchTools(source, FixedFxSource()), backend)
    assert ctx.model_call_count == 1
    assert ctx.estimated_token_count <= limits.max_estimated_tokens
    assert any("Token 预算" in warning for warning in ctx.warnings)


@pytest.mark.asyncio
async def test_goal_coverage_stops_research_when_eligible_minimum_is_met() -> None:
    wave = [_product(f"h{i}", f"Wireless Headphones {i}") for i in range(4)]
    source = _ScriptedSource([wave])
    ctx = _context(
        "headphones",
        limits=ResearchLimits(max_searches=3, minimum_eligible=3),
    )
    ctx.mission = ctx.mission.model_copy(
        update={"goal": ShoppingGoal(target=GoalTarget(item_type="headphones"))}
    )
    await run_deterministic(ctx, ResearchTools(source, FixedFxSource()))
    assert ctx.search_count == 1
    assert ctx.goal_coverage is not None
    assert ctx.goal_coverage.status == "sufficient"
    assert len(ctx.ranked) == 4


@pytest.mark.asyncio
async def test_blocked_candidate_triggers_targeted_detail_evidence_fetch() -> None:
    summary = _product("sony-1", "WH1000XM5 Black")
    detail = summary.model_copy(
        update={"attrs": {"category": "Audio Headphones", "vendor": "Sony"}}
    )
    source = _DetailSource([[summary]], {"sony-1": detail})
    ctx = _context(
        "headphones",
        limits=ResearchLimits(max_searches=1, minimum_eligible=1),
    )
    ctx.mission = ctx.mission.model_copy(
        update={"goal": ShoppingGoal(target=GoalTarget(item_type="headphones"))}
    )
    await run_deterministic(ctx, ResearchTools(source, FixedFxSource()))
    assert source.detail_calls == ["sony-1"]
    assert ctx.goal_coverage is not None
    assert ctx.goal_coverage.status == "sufficient"
    assert [item.id for item in ctx.ranked] == ["sony-1"]


@pytest.mark.asyncio
async def test_failed_evidence_fetch_is_disclosed_and_never_promoted() -> None:
    summary = _product("unknown-1", "Unknown Model X")
    source = _DetailSource([[summary]], {})
    ctx = _context(
        "Unknown Model X",
        limits=ResearchLimits(max_searches=1, minimum_eligible=1),
    )
    ctx.mission = ctx.mission.model_copy(
        update={"goal": ShoppingGoal(target=GoalTarget(item_type="headphones"))}
    )
    await run_deterministic(ctx, ResearchTools(source, FixedFxSource()))
    assert source.detail_calls == ["unknown-1"]
    assert ctx.ranked == []
    assert ctx.goal_coverage is not None
    assert ctx.goal_coverage.status == "blocked_on_evidence"
    assert any("仍缺少" in warning for warning in ctx.warnings)
    assert any(item.purpose == "evidence_supplement" for item in ctx.query_trace)


@pytest.mark.asyncio
async def test_requested_market_is_never_silently_expanded() -> None:
    source = _ScriptedSource([[]])
    ctx = _context("headphones", markets=["TH"])
    ctx.mission = ctx.mission.model_copy(
        update={
            "goal": ShoppingGoal(
                target=GoalTarget(item_type="headphones"),
                retrieval_scope=RetrievalScope(markets_requested=["TH"]),
            )
        }
    )
    await run_deterministic(ctx, ResearchTools(source, FixedFxSource()))
    assert ctx.search_count == 1
    assert ctx.plan.markets == ["TH"]
    assert len(ctx.proposals) == 1
    assert ctx.proposals[0].kind == "expand_markets"
    assert ctx.proposals[0].status == "pending_user_confirmation"


@pytest.mark.asyncio
async def test_model_cannot_stop_a_deterministic_budget_retry() -> None:
    first = [_product("a", "Sony Headphones")]
    source = _ScriptedSource([first, first])
    ctx = _context(
        "headphones",
        budget_cny=4000,
        limits=ResearchLimits(max_searches=2, minimum_eligible=3),
    )
    ctx.mission = ctx.mission.model_copy(
        update={"goal": ShoppingGoal(target=GoalTarget(item_type="headphones"))}
    )
    backend = FakeModelBackend(
        json_replies=[
            {"keep": ["a"]},
            {"query": None},
            {"keep": ["a"]},
            {"ranked": ["a"]},
        ]
    )
    await run_agent(ctx, ResearchTools(source, FixedFxSource()), backend)
    assert ctx.search_count == 2
    assert ctx.relaxed_native_cap is True


@pytest.mark.asyncio
async def test_no_eligible_gain_stops_even_when_new_wrong_type_items_arrive() -> None:
    first = [_product("a", "iPhone 16 Case")]
    second = [_product("b", "iPhone 16 Charger")]
    source = _ScriptedSource([first, second])
    ctx = _context(
        "headphones",
        limits=ResearchLimits(max_searches=4, max_consecutive_no_gain=2),
    )
    ctx.mission = ctx.mission.model_copy(
        update={"goal": ShoppingGoal(target=GoalTarget(item_type="headphones"))}
    )
    backend = FakeModelBackend(json_replies=[{"query": "wireless headphones"}])
    await run_agent(ctx, ResearchTools(source, FixedFxSource()), backend)
    assert ctx.search_count == 2
    assert ctx.stop_reason == "consecutive_no_gain"
    assert ctx.goal_coverage is not None
    assert ctx.goal_coverage.marginal_eligible_count == 0


@pytest.mark.asyncio
async def test_monitor_vertical_slice_qualifies_only_required_4k_products() -> None:
    wave = [
        _product("4k", "Dell 27 Inch 4K UHD Monitor"),
        _product("fhd", "Dell 27 Inch FHD Monitor"),
        _product("arm", "Dual Monitor Arm Desk Mount"),
    ]
    ctx = _context(
        "27 inch 4k monitor",
        limits=ResearchLimits(max_searches=1, minimum_eligible=1),
    )
    ctx.mission = ctx.mission.model_copy(
        update={
            "goal": ShoppingGoal(
                target=GoalTarget(item_type="monitor"),
                constraints=[
                    GoalConstraint(
                        constraint_id="spec-4k",
                        facet="spec_gate:4k",
                        operator="matches",
                        value={"attr": "4k", "cues": ["4k", "uhd"], "required": True},
                    )
                ],
            )
        }
    )
    # Offline vertical-slice evaluation opts in explicitly; runtime publication
    # is still controlled by CategoryContract.
    ctx.enabled_item_types = frozenset({"monitor"})
    await run_deterministic(ctx, ResearchTools(_ScriptedSource([wave]), FixedFxSource()))
    assert [item.id for item in ctx.ranked] == ["4k"]
    assert ctx.goal_coverage is not None
    assert ctx.goal_coverage.status == "sufficient"
