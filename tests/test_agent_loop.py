"""Agent 研究循环测试（AGT-001：LLM 自主编排 + 动态 tool-use）。

离线（fixture + 固定汇率，无 DB、无外网）。覆盖：
- 确定性驱动与 LLM 驱动都产出有效排序候选；
- 硬约束不变量：预算不被违反、排序候选全部可溯源（有 id）；
- 无结果自救：首轮空结果后放宽重搜（PRD 6.7）；
- 护栏：重复调用去抖、跑满步数后安全网补全。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.agent.loop import run_agent, run_deterministic
from backend.agent.tools import ResearchContext, ResearchTools
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.rec import plan_search, rec_state_from_mission
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.product_sources.fixture import FixtureProductSource
from tests.fakes import FakeModelBackend, tool_turn

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "buywhere"
OWNER = "cccccccc-cccc-cccc-cccc-cccccccccccc"

pytestmark = pytest.mark.unit


def _context(query: str, *, budget_cny: float | None = None, markets: list[str] | None = None) -> ResearchContext:
    mission = ShoppingMission(
        owner_id=OWNER,
        title="研究循环测试",
        constraints=MissionConstraints(query=query, budget_cny=budget_cny, markets=markets or ["US"]),
    )
    plan = plan_search(rec_state_from_mission(mission))
    return ResearchContext(mission=mission, plan=plan)


def _tools() -> ResearchTools:
    return ResearchTools(FixtureProductSource(FIXTURES), FixedFxSource(), max_concurrency=3)


def _assert_traceable(ctx: ResearchContext) -> None:
    for product in ctx.ranked:
        assert product.id, "排序候选必须可溯源（有 id）"


def _assert_budget(ctx: ResearchContext, budget: float) -> None:
    for product in ctx.ranked:
        if product.fx_failed:
            continue  # 换算失败保留原币，不因预算排除
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
    # fixture 商品约 ¥3594：预算 4000 应保留，且不违反预算。
    ctx = _context("索尼降噪耳机", budget_cny=4000, markets=["US"])
    await run_deterministic(ctx, _tools())
    assert ctx.ranked
    _assert_budget(ctx, 4000)


@pytest.mark.asyncio
async def test_deterministic_driver_empties_when_all_over_budget() -> None:
    # fixture 商品约 ¥3594，预算 3000 应全部被硬过滤（预算不可违反）。
    ctx = _context("索尼降噪耳机", budget_cny=3000, markets=["US"])
    await run_deterministic(ctx, _tools())
    assert ctx.ranked == []
    assert any("超出预算" in w for w in ctx.warnings)


@pytest.mark.asyncio
async def test_agent_loop_scripted_trace_produces_ranked() -> None:
    ctx = _context("索尼降噪耳机", budget_cny=4000, markets=["US"])
    backend = FakeModelBackend(
        [
            tool_turn(("search_products", {})),
            tool_turn(("convert_fx", {})),
            tool_turn(("filter_candidates", {})),
            tool_turn(("rank_candidates", {})),
            tool_turn(("finalize", {"reason": "ranked ready"})),
        ]
    )
    await run_agent(ctx, _tools(), backend)
    assert ctx.finalized
    assert ctx.ranked
    _assert_traceable(ctx)
    _assert_budget(ctx, 4000)


@pytest.mark.asyncio
async def test_agent_loop_recovers_from_empty_results() -> None:
    """首轮检索空市场（TH 无 fixture）后放宽到 US 重搜，最终仍有候选（PRD 6.7）。"""
    ctx = _context("索尼降噪耳机", markets=["TH"])
    backend = FakeModelBackend(
        [
            tool_turn(("search_products", {"markets": ["TH"]})),
            tool_turn(("filter_candidates", {})),  # 空结果
            tool_turn(("search_products", {"markets": ["US"], "query": "sony"})),
            tool_turn(("convert_fx", {})),
            tool_turn(("filter_candidates", {})),
            tool_turn(("rank_candidates", {})),
            tool_turn(("finalize", {})),
        ]
    )
    await run_agent(ctx, _tools(), backend)
    assert ctx.ranked, "放宽重搜后应恢复出候选"
    _assert_traceable(ctx)


@pytest.mark.asyncio
async def test_agent_loop_safety_net_completes_when_model_stalls() -> None:
    """模型只检索就停手（never finalize / never rank）→ 安全网确定性补全。"""
    ctx = _context("索尼降噪耳机", markets=["US"])
    backend = FakeModelBackend([tool_turn(("search_products", {}))])  # 之后返回终稿
    await run_agent(ctx, _tools(), backend, max_steps=3)
    assert ctx.ranked, "安全网应补全出排序候选"
    _assert_traceable(ctx)


@pytest.mark.asyncio
async def test_agent_loop_dedupes_repeated_calls() -> None:
    ctx = _context("索尼降噪耳机", markets=["US"])
    backend = FakeModelBackend(
        [
            tool_turn(("search_products", {})),
            tool_turn(("search_products", {})),  # 完全相同 → 去抖跳过
            tool_turn(("convert_fx", {})),
            tool_turn(("rank_candidates", {})),
            tool_turn(("finalize", {})),
        ]
    )
    await run_agent(ctx, _tools(), backend)
    assert ctx.ranked
    _assert_traceable(ctx)
