"""研究循环不变量评测基线（Agent 专属指标，AGT-003/AGT-004）。

放弃无 Key 底线、转向 LLM 自主编排后，图快照测试不再适用。这里立两条必须恒真的标尺，
作为后续 Phase 2/3 的回归门禁：
- 硬约束违反率 = 0：排序候选中不得有超预算项（换算失败项保留原币，不计违反）；
- 证据可追溯率 = 100%：每个排序候选都有可溯源 id（供 commit gate 引用校验）。

对确定性驱动与 LLM 驱动（脚本轨迹）双轨断言，保证两种驱动都守住不变量。
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
from tests.fakes import FakeModelBackend

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "buywhere"
OWNER = "dddddddd-dddd-dddd-dddd-dddddddddddd"

pytestmark = pytest.mark.unit

# (查询, 预算, 市场)
CASES = [
    ("索尼降噪耳机", None, ["US"]),
    ("索尼降噪耳机", 4000, ["US"]),
    ("索尼降噪耳机", 3000, ["US"]),
    ("wireless earbuds", 2000, ["US"]),
    ("sony", 5000, ["US"]),
]

def _context(query: str, budget: float | None, markets: list[str]) -> ResearchContext:
    mission = ShoppingMission(
        owner_id=OWNER,
        title="invariant",
        constraints=MissionConstraints(query=query, budget_cny=budget, markets=markets),
    )
    return ResearchContext(mission=mission, plan=plan_search(rec_state_from_mission(mission)))


def _tools() -> ResearchTools:
    return ResearchTools(FixtureProductSource(FIXTURES), FixedFxSource(), max_concurrency=3)


def _violations(ctx: ResearchContext, budget: float | None) -> list[str]:
    problems: list[str] = []
    for product in ctx.ranked:
        if not product.id:
            problems.append("untraceable candidate (no id)")
        if budget is not None and not product.fx_failed:
            if product.rmb_price is None or product.rmb_price > budget:
                problems.append(f"budget violated: {product.id} rmb={product.rmb_price} > {budget}")
    return problems


@pytest.mark.asyncio
async def test_deterministic_driver_holds_invariants() -> None:
    failures: list[str] = []
    for query, budget, markets in CASES:
        ctx = _context(query, budget, markets)
        await run_deterministic(ctx, _tools())
        failures += [f"[det:{query}/{budget}] {p}" for p in _violations(ctx, budget)]
    assert not failures, "确定性驱动违反不变量:\n" + "\n".join(failures)


@pytest.mark.asyncio
async def test_agent_driver_holds_invariants() -> None:
    failures: list[str] = []
    for query, budget, markets in CASES:
        ctx = _context(query, budget, markets)
        await run_agent(ctx, _tools(), FakeModelBackend())
        failures += [f"[llm:{query}/{budget}] {p}" for p in _violations(ctx, budget)]
    assert not failures, "LLM 驱动违反不变量:\n" + "\n".join(failures)
