"""LLM 接缝测试（P3-W03 门禁，AGT-003/AGT-006）。

- UnconfiguredModelBackend 任何调用返回明确 capability unavailable，不抛未处理异常；
- 无 LLM Key 时完整 Agent 图仍走确定性路径（fallback），验收不被阻塞。
"""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.agent.graph import build_graph
from backend.agent.runner import LangGraphMissionRunner
from backend.application.dto import IntentPatch, RecommendationDraft
from backend.application.dto.dialogue import DialogueAct, DialogueActKind
from backend.application.errors import ModelUnavailableError
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.llm.factory import UnsupportedLLMProviderError, build_model_backend
from backend.infrastructure.llm.openai_compat import (
    DEFAULT_MODEL,
    OpenAICompatModelBackend,
    completions_url,
    extract_json_object,
    sanitize_dialogue_act,
    sanitize_intent_patch,
)
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
async def test_unconfigured_parse_turn_raises_clear_error() -> None:
    with pytest.raises(ModelUnavailableError) as exc:
        await UnconfiguredModelBackend().parse_turn("帮我比前两个")
    assert "unconfigured" in str(exc.value)


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


# ── OpenAI 兼容协议（DeepSeek-V4-Flash） ───────────────────

CHAT_URL = "https://api.deepseek.com/chat/completions"


def _chat_response(content: str) -> dict:
    return {
        "id": "chatcmpl-test",
        "choices": [{"message": {"role": "assistant", "content": content}}],
    }


def test_completions_url_and_json_extract() -> None:
    assert completions_url("https://api.deepseek.com") == CHAT_URL
    assert completions_url("https://api.deepseek.com/v1") == "https://api.deepseek.com/v1/chat/completions"
    assert extract_json_object('```json\n{"query":"降噪耳机"}\n```')["query"] == "降噪耳机"


def test_sanitize_intent_patch_drops_unknown_markets() -> None:
    patch = sanitize_intent_patch(
        IntentPatch(query="  耳机  ", markets=["US", "XX"], preference="magic", source="deterministic")
    )
    assert patch.query == "耳机"
    assert patch.markets == ["US"]
    assert patch.preference is None
    assert patch.source == "model"


def test_sanitize_intent_patch_cleans_open_soft_prefs() -> None:
    from backend.application.dto.belief import SoftPref

    patch = sanitize_intent_patch(
        IntentPatch(
            query="登山表",
            soft_prefs=[
                SoftPref(attr="  防水 ", direction="bogus", cues=["waterproof", "  ", "ip68"]),
                SoftPref(attr="price", cues=["x"]),  # 保留通道，不接受从这里改写
                SoftPref(attr="", cues=["y"]),  # 空 attr 丢弃
            ],
        )
    )
    assert patch.soft_prefs is not None
    assert [p.attr for p in patch.soft_prefs] == ["防水"]
    dim = patch.soft_prefs[0]
    assert dim.direction == "higher"  # 非法方向归一
    assert dim.status == "active"
    assert dim.cues == ["waterproof", "ip68"]  # 空白 cue 去除


def test_factory_requires_key_and_rejects_unknown_provider() -> None:
    assert isinstance(build_model_backend(provider="unconfigured"), UnconfiguredModelBackend)
    with pytest.raises(UnsupportedLLMProviderError, match="INTEREC_LLM_API_KEY"):
        build_model_backend(provider="openai_compat", api_key="")
    with pytest.raises(UnsupportedLLMProviderError, match="暂未实现"):
        build_model_backend(provider="anthropic", api_key="sk-test")
    backend = build_model_backend(provider="deepseek", api_key="sk-test")
    assert isinstance(backend, OpenAICompatModelBackend)
    assert backend.is_configured() is True


@pytest.mark.asyncio
async def test_openai_compat_parse_intent_from_official_payload() -> None:
    content = (
        '{"query":"通勤降噪耳机","budget_cny":2500,"markets":["US","SG"],'
        '"preference":"noise","requires_clarification":false}'
    )
    with respx.mock:
        route = respx.post(CHAT_URL).mock(return_value=httpx.Response(200, json=_chat_response(content)))
        backend = OpenAICompatModelBackend("sk-test", model=DEFAULT_MODEL)
        patch = await backend.parse_intent("通勤降噪耳机，预算 2500，美国和新加坡，优先降噪")
    assert route.called
    request = route.calls[0].request
    assert request.headers["Authorization"] == "Bearer sk-test"
    body = request.content
    assert b"deepseek-v4-flash" in body
    assert b"json_object" in body
    assert b"disabled" in body
    assert patch.query == "通勤降噪耳机"
    assert patch.budget_cny == 2500
    assert patch.markets == ["US", "SG"]
    assert patch.source == "model"


@pytest.mark.asyncio
async def test_openai_compat_parse_intent_extracts_open_soft_prefs() -> None:
    """LLM 把开放式偏好放进 soft_prefs（带跨语言 cues），不塞进 preference 枚举（§5.1）。"""
    content = (
        '{"query":"登山手表","preference":"balanced","requires_clarification":false,'
        '"soft_prefs":[{"attr":"防水","direction":"higher",'
        '"cues":["waterproof","ip68"]}]}'
    )
    with respx.mock:
        respx.post(CHAT_URL).mock(return_value=httpx.Response(200, json=_chat_response(content)))
        patch = await OpenAICompatModelBackend("sk-test").parse_intent("要防水的登山手表")
    assert patch.soft_prefs is not None
    assert patch.soft_prefs[0].attr == "防水"
    assert patch.soft_prefs[0].cues == ["waterproof", "ip68"]
    assert patch.source == "model"


@pytest.mark.asyncio
async def test_openai_compat_invalid_json_and_401_are_unavailable() -> None:
    backend = OpenAICompatModelBackend("sk-test")
    with respx.mock:
        respx.post(CHAT_URL).mock(return_value=httpx.Response(200, json=_chat_response("不是 JSON")))
        with pytest.raises(ModelUnavailableError):
            await backend.parse_intent("降噪耳机")
    with respx.mock:
        respx.post(CHAT_URL).mock(return_value=httpx.Response(401, json={"error": "invalid"}))
        with pytest.raises(ModelUnavailableError) as exc:
            await backend.parse_intent("降噪耳机")
    assert "sk-test" not in str(exc.value)


@pytest.mark.asyncio
async def test_openai_compat_draft_recommendation_validates_schema() -> None:
    content = (
        '{"primary_snapshot_id":"p1","alternative_snapshot_ids":["p2"],'
        '"rationale":["预算内人民币估算较低"],"tradeoffs":["库存未提供"],'
        '"cited_evidence_ids":["p1","p2"]}'
    )
    with respx.mock:
        respx.post(CHAT_URL).mock(return_value=httpx.Response(200, json=_chat_response(content)))
        draft = await OpenAICompatModelBackend("sk-test").draft_recommendation(
            constraints={"budget_cny": 2500},
            candidates=[{"id": "p1", "title": "A"}, {"id": "p2", "title": "B"}],
            evidence=None,
        )
    assert isinstance(draft, RecommendationDraft)
    assert draft.primary_snapshot_id == "p1"
    assert draft.alternative_snapshot_ids == ["p2"]


@pytest.mark.asyncio
async def test_openai_compat_parse_turn_compare_does_not_fill_query() -> None:
    content = (
        '{"kind":"compare_items","referent_ranks":[1,2],"exclude_terms":[],'
        '"stance":null,"topic":null,'
        '"patch":{"query":"前两个","requires_clarification":false}}'
    )
    with respx.mock:
        respx.post(CHAT_URL).mock(return_value=httpx.Response(200, json=_chat_response(content)))
        act = await OpenAICompatModelBackend("sk-test").parse_turn("帮我比前两个", current_query="降噪耳机")
    assert act.kind == DialogueActKind.COMPARE
    assert act.referent_ranks == [1, 2]
    assert act.source == "model"
    assert act.patch is None or act.patch.query is None


def test_sanitize_dialogue_act_strips_query_from_talk() -> None:
    act = sanitize_dialogue_act(
        DialogueAct(
            kind=DialogueActKind.STANCE,
            stance="too_expensive",
            patch=IntentPatch(query="太贵了", budget_cny=2000),
        )
    )
    assert act.patch is not None
    assert act.patch.query is None
    assert act.source == "model"
