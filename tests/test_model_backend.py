"""LLM 接缝测试（P3-W03 门禁，AGT-003/AGT-006）。

- UnconfiguredModelBackend 任何调用返回明确 capability unavailable，不抛未处理异常；
- 无 LLM Key 时完整 Agent 图仍走确定性路径（fallback），验收不被阻塞。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.agent.graph import build_graph
from backend.agent.runner import LangGraphMissionRunner
from backend.application.dto import IntentPatch
from backend.application.errors import ModelUnavailableError
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.llm.unconfigured import UnconfiguredModelBackend
from backend.infrastructure.persistence.unit_of_work import SqlAlchemyUnitOfWork
from backend.infrastructure.product_sources.fixture import FixtureProductSource

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "buywhere"
TEST_DB_URL = "postgresql+asyncpg://interec:interec@localhost:5432/interec_test"
OWNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

pytestmark = pytest.mark.agent

TRUNCATE_SQL = (
    "TRUNCATE TABLE mission_events, candidate_sets, recommendation_runs, "
    "product_snapshots, fx_snapshots, idempotency_records, shopping_missions "
    "RESTART IDENTITY CASCADE"
)


def test_unconfigured_backend_is_not_configured() -> None:
    assert UnconfiguredModelBackend().is_configured() is False


@pytest.mark.asyncio
async def test_unconfigured_parse_intent_raises_clear_error() -> None:
    with pytest.raises(ModelUnavailableError) as exc:
        await UnconfiguredModelBackend().parse_intent("降噪耳机")
    assert "unconfigured" in str(exc.value)
    assert "确定性" in str(exc.value)  # 给出可执行建议


@pytest.mark.asyncio
async def test_unconfigured_draft_recommendation_raises() -> None:
    with pytest.raises(ModelUnavailableError):
        await UnconfiguredModelBackend().draft_recommendation(
            constraints=object(), candidates=[], evidence=object()
        )


def test_structured_output_schema_rejects_bad_intent() -> None:
    """AGT-003：ModelBackend 只允许结构化输出；非法结构被 Pydantic 拒绝。"""
    with pytest.raises(ValueError):
        IntentPatch.model_validate({"query": 123, "budget_cny": "not-a-number"})


# ── 无 LLM Key 的完整图仍可验收（AGT-006） ───────────────────

@pytest.fixture
async def db():
    engine = create_async_engine(TEST_DB_URL)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.exec_driver_sql(TRUNCATE_SQL)
    yield sf
    await engine.dispose()


async def _create_mission_with_message(sf, text: str) -> str:
    async with SqlAlchemyUnitOfWork(sf) as uow:
        mission = await uow.missions.create(owner_id=OWNER, title="无 LLM 任务")
        await uow.events.append(
            mission_id=mission.id,
            event_type="message.received",
            payload={"text": text, "constraints_version": 1},
        )
        await uow.commit()
        return mission.id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_full_graph_runs_without_llm_key(db) -> None:
    """无 LLM Key 时完整 Agent 图仍通过全部骨架验收。"""
    mission_id = await _create_mission_with_message(db, "通勤降噪耳机，预算 4000 元")
    graph = build_graph(
        products=FixtureProductSource(FIXTURES),
        fx=FixedFxSource(),
        model_backend=UnconfiguredModelBackend(),
        uow_factory=lambda: SqlAlchemyUnitOfWork(db),
    )
    runner = LangGraphMissionRunner(graph)
    result = await runner.run(
        owner_id=OWNER, mission_id=mission_id, run_id="00000000-0000-0000-0000-000000000009", constraints_version=1
    )
    assert result.status.value == "completed"

    async with SqlAlchemyUnitOfWork(db) as uow:
        mission = await uow.missions.get(owner_id=OWNER, mission_id=mission_id)
    assert mission is not None
    assert mission.stage.value == "ready"
    assert mission.candidate_set_id is not None
