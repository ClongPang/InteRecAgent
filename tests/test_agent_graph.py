"""Agent 状态图测试（P3 门禁）。

- P3-W01（unit）：图结构快照——显式节点齐全、关键路由存在。
- P3-W02（integration，fixture + 测试库）：正常、追问、无结果、FX 失败、部分市场失败、superseded。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.agent.graph import NODE_NAMES, build_graph
from backend.agent.nodes.decide import released_category_clarification
from backend.agent.runner import LangGraphMissionRunner
from backend.application.dto import ProductSearchResult, ShoppingMission
from backend.application.errors import UpstreamUnavailableError
from backend.application.services import MissionCommandService
from backend.domain.models import FxSnapshot
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.llm.unconfigured import UnconfiguredModelBackend
from backend.infrastructure.persistence.orm import ProductSnapshotRow
from backend.infrastructure.persistence.unit_of_work import SqlAlchemyUnitOfWork
from backend.infrastructure.product_sources.buywhere import (
    BuyWhereSearchResponse,
    _normalize_response,
)
from backend.infrastructure.product_sources.fixture import FixtureProductSource
from backend.infrastructure.runtime.in_process_dispatcher import InProcessRunDispatcher

TEST_DB_URL = "postgresql+asyncpg://interec:interec@localhost:5432/interec_test"
FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "buywhere"
OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

pytestmark = pytest.mark.agent

TRUNCATE_SQL = (
    "TRUNCATE TABLE mission_events, candidate_sets, recommendation_runs, "
    "product_snapshots, fx_snapshots, idempotency_records, shopping_missions "
    "RESTART IDENTITY CASCADE"
)


# ── P3-W01：图结构（离线） ─────────────────────────────────────

class _NeverInvoked:
    async def search(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def get_rate(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    def is_configured(self) -> bool:
        raise AssertionError("结构测试不应执行节点")

    def supports_tools(self) -> bool:
        raise AssertionError("结构测试不应执行节点")

    async def chat(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def complete_json(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def parse_intent(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def parse_decision(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def parse_turn(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def pick_probe(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")

    async def draft_recommendation(self, *a, **k):
        raise AssertionError("结构测试不应执行节点")


def _stub_uow_factory():
    class _U:
        pass

    return lambda: _U()


def test_graph_has_required_nodes_and_routes() -> None:
    """AGT-001：对话路由与检索子图节点齐全，构建成功。"""
    graph = build_graph(
        products=_NeverInvoked(),
        fx=_NeverInvoked(),
        model_backend=_NeverInvoked(),
        uow_factory=_stub_uow_factory(),
    )
    compiled_nodes = set(graph.get_graph().nodes.keys())
    assert all(name in compiled_nodes for name in NODE_NAMES)


def test_node_names_match_spec() -> None:
    """Goal V2 artifact boundaries must be explicit graph nodes."""
    required = {
        "assess_next_action", "plan_research", "retrieve_buywhere",
        "normalize_observation", "build_semantic_profile", "qualify_candidates",
        "assess_coverage", "rank_feasible", "build_answer_plan", "verify_claims",
        "render_response", "completion_check", "persist_decision_snapshot",
    }
    assert required <= set(NODE_NAMES)
    assert "execute_ops" not in NODE_NAMES


def test_unreleased_category_message_uses_actual_feature_gate() -> None:
    message = released_category_clarification(frozenset({"smartphone", "headphones"}))

    assert "手机、耳机" in message
    assert "显示器" not in message
    assert "尚未开放" in message


def test_bind_trigger_uses_this_run_event() -> None:
    from backend.agent.nodes.fetch import _bind_trigger

    mission = ShoppingMission(id="m", owner_id=OWNER, title="t")
    events = [
        {"event_type": "message.received", "payload": {"run_id": "r1", "text": "first"}},
        {"event_type": "constraints.updated", "payload": {"run_id": "r2"}},
        {"event_type": "message.received", "payload": {"run_id": "r3", "text": "latest"}},
    ]
    constraint_run = _bind_trigger(mission, events, "r2")
    assert constraint_run["skip_intent_patch"] is True
    assert constraint_run["text"] == ""
    accepted = _bind_trigger(
        mission,
        events + [{"event_type": "run.accepted", "payload": {"run_id": "r2"}}],
        "r2",
    )
    assert accepted["skip_intent_patch"] is True
    assert accepted["text"] == ""
    first_msg = _bind_trigger(mission, events, "r1")
    assert first_msg["text"] == "first"
    assert first_msg["skip_intent_patch"] is False
    decided = _bind_trigger(
        mission,
        [
            {
                "event_type": "message.received",
                "payload": {
                    "run_id": "r4",
                    "text": "不要这款",
                    "turn_route": "rerank",
                    "act_payload": {"kind": "reject_item", "referent_ranks": [1]},
                    "skip_intent_patch": True,
                },
            }
        ],
        "r4",
    )
    assert decided["decided_route"] == "rerank"
    assert decided["decided_act"]["kind"] == "reject_item"
    assert decided["skip_intent_patch"] is True


# ── P3-W02：确定性基础路径（integration） ─────────────────────

@pytest.fixture
async def db():
    engine = create_async_engine(TEST_DB_URL)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.exec_driver_sql(TRUNCATE_SQL)
    yield sf
    await engine.dispose()


def _sony_result() -> ProductSearchResult:
    body = json.loads((FIXTURES / "search_sony_keyword_us.json").read_text(encoding="utf-8"))
    resp = BuyWhereSearchResponse.model_validate(body)
    return _normalize_response(resp, retrieval_context={"test_fixture": True})


def _runner(sf, *, products=None, fx=None) -> LangGraphMissionRunner:
    graph = build_graph(
        products=products or FixtureProductSource(FIXTURES),
        fx=fx or FixedFxSource(),
        model_backend=UnconfiguredModelBackend(),
        uow_factory=lambda: SqlAlchemyUnitOfWork(sf),
    )
    return LangGraphMissionRunner(graph)


async def _create_mission_with_message(sf, text: str, owner: str = OWNER) -> ShoppingMission:
    async with SqlAlchemyUnitOfWork(sf) as uow:
        mission = await uow.missions.create(owner_id=owner, title="选购任务")
        await uow.events.append(
            mission_id=mission.id,
            event_type="message.received",
            payload={"text": text, "constraints_version": 1},
        )
        await uow.commit()
        return mission


async def _load_mission(sf, mission_id: str) -> ShoppingMission:
    async with SqlAlchemyUnitOfWork(sf) as uow:
        mission = await uow.missions.get(owner_id=OWNER, mission_id=mission_id)
        assert mission is not None
        return mission


async def _candidate_set(sf, candidate_set_id: str) -> dict | None:
    async with SqlAlchemyUnitOfWork(sf) as uow:
        return await uow.candidate_sets.get(candidate_set_id)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_normal_path_reaches_ready(db) -> None:
    mission = await _create_mission_with_message(db, "通勤降噪耳机，预算 4000 元，美国")
    result = await _runner(db).run(
        owner_id=OWNER, mission_id=mission.id, run_id="00000000-0000-0000-0000-000000000001", constraints_version=1
    )
    assert result.status.value == "completed"
    assert result.candidate_set_id is not None

    loaded = await _load_mission(db, mission.id)
    assert loaded.stage.value == "ready"
    # 首次合并把空约束写成查询+预算，1→2；不是「每次 run +1」
    assert loaded.constraints_version == 2
    assert loaded.candidate_set_id == result.candidate_set_id
    assert loaded.constraints.query == "通勤降噪耳机"
    assert loaded.constraints.budget_cny == 4000
    async with SqlAlchemyUnitOfWork(db) as uow:
        stored_run = await uow.recommendation_runs.get(result.recommendation_run_id)
        events = await uow.events.list_since(mission_id=mission.id)
    assert stored_run is not None
    assert stored_run["final_json"]["verification"] == "passed"
    assert stored_run["final_json"]["claim_ledger"]["candidate_set_id"] == result.candidate_set_id
    bundle = stored_run["final_json"]["decision_bundle"]
    assert bundle["schema_version"] == "decision-bundle-v1"
    assert bundle["goal_version"] == loaded.goal.goal_version
    assert bundle["candidate_set_id"] == result.candidate_set_id
    assert bundle["answer_plan"] == stored_run["final_json"]["answer_plan"]
    assert bundle["claim_ledger"] == stored_run["final_json"]["claim_ledger"]
    assert any(event["event_type"] == "answer.claims_verified" for event in events)
    candidate_set = await _candidate_set(db, result.candidate_set_id)
    assert candidate_set is not None
    assert candidate_set["search_executions"]
    assert candidate_set["product_observations"]
    assert all(item.get("snapshot_id") for item in candidate_set["product_observations"])
    assert all(item.get("rank_explanation") for item in candidate_set["ranked"])
    assert all(
        item["rank_explanation"]["assessment_reason_codes"]
        for item in candidate_set["ranked"]
    )
    assert all(
        item["goal_version"] == loaded.goal.goal_version
        for item in candidate_set["search_executions"]
    )
    assert all(
        item["goal_version"] == loaded.goal.goal_version
        for item in candidate_set["product_observations"]
    )
    assert all(
        item["goal_version"] == loaded.goal.goal_version
        and all(
            assessment["goal_version"] == loaded.goal.goal_version
            for assessment in item["assessments"]
        )
        for item in candidate_set["qualifications"]
    )
    async with db() as session:
        snapshot = (await session.scalars(select(ProductSnapshotRow).limit(1))).first()
    assert snapshot is not None
    assert snapshot.raw_json["source_product_id"]
    assert snapshot.raw_json["raw_item"]["title"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_goal_revision_is_committed_before_product_source_call(db) -> None:
    mission = await _create_mission_with_message(db, "Sony 耳机，预算 2500 元，美国")

    class AssertCommittedSource:
        async def search(self, query, *, country_code, mode="keyword", limit=20, max_price=None):
            del query, country_code, mode, limit, max_price
            current = await _load_mission(db, mission.id)
            assert current.constraints_version == 2
            assert current.goal.target.item_type == "headphones"
            assert current.goal.target.brand == "Sony"
            async with SqlAlchemyUnitOfWork(db) as uow:
                events = await uow.events.list_since(mission_id=mission.id)
            kinds = [event["event_type"] for event in events]
            assert "goal.operations_proposed" in kinds
            assert "goal.operations_committed" in kinds
            return _sony_result()

        async def get_product(self, product_id):
            del product_id
            return None

    result = await _runner(db, products=AssertCommittedSource()).run(
        owner_id=OWNER,
        mission_id=mission.id,
        run_id="00000000-0000-0000-0000-00000000000b",
        constraints_version=1,
    )
    assert result.status.value in {"completed", "degraded"}


@pytest.mark.integration
@pytest.mark.asyncio
async def test_clarification_when_no_query(db) -> None:
    mission = await _create_mission_with_message(db, "预算 2000 元")
    result = await _runner(db).run(
        owner_id=OWNER, mission_id=mission.id, run_id="00000000-0000-0000-0000-000000000002", constraints_version=1
    )
    assert result.status.value == "completed"
    loaded = await _load_mission(db, mission.id)
    assert loaded.stage.value == "clarifying"
    # 预算本身是有效 Goal revision：先原子提交，再就缺失品类澄清。
    assert loaded.constraints_version == 2
    assert loaded.constraints.budget_cny == 2000


@pytest.mark.integration
@pytest.mark.asyncio
async def test_unvalidated_fourth_category_is_blocked_before_search(db) -> None:
    class FailOnSearch:
        async def search(self, *args, **kwargs):
            raise AssertionError("未通过品类门槛时不得访问商品源")

        async def get_product(self, product_id):
            del product_id
            return None

    mission = await _create_mission_with_message(db, "MacBook Air laptop")
    result = await _runner(db, products=FailOnSearch()).run(
        owner_id=OWNER,
        mission_id=mission.id,
        run_id="00000000-0000-0000-0000-00000000000c",
        constraints_version=1,
    )
    assert result.status.value == "completed"
    loaded = await _load_mission(db, mission.id)
    assert loaded.stage.value == "clarifying"
    assert loaded.goal.target.item_type == "laptop"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_no_results_is_degraded(db) -> None:
    # Use a query that remains empty even after the agent widens markets.
    expected_mission = await _create_mission_with_message(
        db, "iPhone 15 Pro, budget CNY 1, Thailand"
    )
    result = await _runner(db).run(
        owner_id=OWNER, mission_id=expected_mission.id, run_id="00000000-0000-0000-0000-000000000003", constraints_version=1
    )
    assert result.status.value == "degraded"
    loaded = await _load_mission(db, expected_mission.id)
    assert loaded.stage.value == "degraded"
    assert loaded.candidate_set_id is not None  # 空候选集也已记录
    async with SqlAlchemyUnitOfWork(db) as uow:
        candidate_set = await uow.candidate_sets.get(loaded.candidate_set_id)
        events = await uow.events.list_since(mission_id=expected_mission.id)
    assert candidate_set is not None
    assert candidate_set["coverage"]["status"] == "insufficient"
    assert candidate_set["ranked"] == []
    assert any(event["event_type"] == "goal.operations_committed" for event in events)
    assert any(event["event_type"] == "coverage.assessed" for event in events)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_fx_failure_keeps_products_and_degrades(db) -> None:
    class FailingFx:
        async def get_rate(self, base, quote) -> FxSnapshot:
            raise UpstreamUnavailableError(code="fx_unavailable", category="upstream", retryable=True)

    mission = await _create_mission_with_message(db, "索尼降噪耳机")
    result = await _runner(db, fx=FailingFx()).run(
        owner_id=OWNER, mission_id=mission.id, run_id="00000000-0000-0000-0000-000000000004", constraints_version=1
    )
    assert result.status.value == "degraded"
    loaded = await _load_mission(db, mission.id)
    assert loaded.stage.value == "degraded"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_partial_market_failure_keeps_other_results(db) -> None:
    class FailUSThenSony:
        """US 失败，SG 返回索尼候选（AC-006：部分成功）。"""

        async def search(self, query, *, country_code, mode="keyword", limit=20, max_price=None):
            if country_code == "US":
                raise UpstreamUnavailableError(code="rate_limited", category="upstream", retryable=True)
            return _sony_result()

        async def get_product(self, product_id):
            return None

    mission = await _create_mission_with_message(db, "索尼耳机，美国和新加坡")
    result = await _runner(db, products=FailUSThenSony()).run(
        owner_id=OWNER, mission_id=mission.id, run_id="00000000-0000-0000-0000-000000000005", constraints_version=1
    )
    # US 失败但 SG 有结果 → 保留候选，任务 degraded，US 警告存在
    loaded = await _load_mission(db, mission.id)
    assert loaded.stage.value == "degraded"
    assert any("US 搜索失败" in w for w in loaded.warnings)
    assert result.status.value == "degraded"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_stale_run_is_superseded(db) -> None:
    """AGT-005：旧版本运行（run_version=1）在新版本任务后完成 → 标记 superseded，不提交候选。"""
    mission = await _create_mission_with_message(db, "通勤降噪耳机，预算 4000 元")
    # 第一次运行：首次合并约束 1→2，正常完成
    first = await _runner(db).run(
        owner_id=OWNER, mission_id=mission.id, run_id="00000000-0000-0000-0000-000000000006", constraints_version=1
    )
    assert first.status.value == "completed"
    loaded = await _load_mission(db, mission.id)
    assert loaded.constraints_version == 2

    # 第二次运行持有旧版本 1 → 被 superseded
    second = await _runner(db).run(
        owner_id=OWNER, mission_id=mission.id, run_id="00000000-0000-0000-0000-000000000007", constraints_version=1
    )
    assert second.status.value == "superseded"
    # 任务仍指向第一次运行的结果
    reloaded = await _load_mission(db, mission.id)
    assert reloaded.constraints_version == 2
    assert reloaded.candidate_set_id == first.candidate_set_id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_repeat_message_does_not_bump_version(db) -> None:
    """同一句话再次检索：约束未变，constraints_version 保持。"""
    text = "通勤降噪耳机，预算 4000 元"
    mission = await _create_mission_with_message(db, text)
    first = await _runner(db).run(
        owner_id=OWNER,
        mission_id=mission.id,
        run_id="00000000-0000-0000-0000-000000000008",
        constraints_version=1,
    )
    assert first.status.value == "completed"
    loaded = await _load_mission(db, mission.id)
    assert loaded.constraints_version == 2

    run_id = "00000000-0000-0000-0000-00000000000a"
    async with SqlAlchemyUnitOfWork(db) as uow:
        await uow.events.append(
            mission_id=mission.id,
            event_type="message.received",
            payload={"text": text, "constraints_version": 2, "run_id": run_id},
        )
        await uow.commit()

    second = await _runner(db).run(
        owner_id=OWNER, mission_id=mission.id, run_id=run_id, constraints_version=2
    )
    assert second.status.value == "completed"
    reloaded = await _load_mission(db, mission.id)
    assert reloaded.constraints_version == 2
    assert reloaded.candidate_set_id == second.candidate_set_id


# ── 完整链路：MissionCommandService → Dispatcher → Runner ─────

@pytest.mark.integration
@pytest.mark.asyncio
async def test_mission_command_service_full_chain(db) -> None:
    """DEC-009：HTTP Command Service 只依赖 RunDispatcher Port，调度器驱动 LangGraph runner。"""
    runner = _runner(db)
    dispatcher = InProcessRunDispatcher(runner, db)
    service = MissionCommandService(
        uow_factory=lambda: SqlAlchemyUnitOfWork(db),
        dispatcher=dispatcher,
    )
    mission = await service.create_mission(owner_id=OWNER, title="通勤降噪耳机")

    run_id = await service.submit_message(
        owner_id=OWNER, mission_id=mission.id, text="通勤降噪耳机，预算 4000 元", constraints_version=1
    )
    assert run_id

    await asyncio.sleep(0.5)  # 后台任务可能未完成，轮询终态
    loaded = None
    for _ in range(50):
        loaded = await _load_mission(db, mission.id)
        if loaded.stage.value in {"ready", "degraded", "clarifying", "failed"}:
            break
        await asyncio.sleep(0.1)
    assert loaded is not None
    assert loaded.stage.value == "ready"
    assert loaded.recommendation_run_id == run_id
    assert loaded.candidate_set_id is not None
