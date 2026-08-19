"""DeepSeek 官方 OpenAI 兼容协议冒烟。默认 skip；有 INTEREC_LLM_API_KEY 时才打真实请求。"""
from __future__ import annotations

import pytest

from backend.bootstrap.settings import Settings
from backend.infrastructure.llm.openai_compat import OpenAICompatModelBackend

pytestmark = [pytest.mark.live, pytest.mark.asyncio]


@pytest.fixture
def settings() -> Settings:
    return Settings()


async def test_live_deepseek_v4_flash_parse_intent(settings: Settings) -> None:
    if settings.llm_provider == "unconfigured" or not settings.llm_api_key:
        pytest.skip("未配置 INTEREC_LLM_API_KEY，跳过真实模型冒烟")
    backend = OpenAICompatModelBackend(
        settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
    )
    try:
        patch = await backend.parse_intent("通勤降噪耳机，预算 2500 元，美国")
    finally:
        await backend.aclose()
    assert patch.source == "model"
    assert patch.budget_cny == 2500
    assert patch.markets == ["US"]
    assert patch.requires_clarification is False


async def test_live_deepseek_v4_flash_parse_turn_compare(settings: Settings) -> None:
    if settings.llm_provider == "unconfigured" or not settings.llm_api_key:
        pytest.skip("未配置 INTEREC_LLM_API_KEY，跳过真实模型冒烟")
    backend = OpenAICompatModelBackend(
        settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
    )
    try:
        act = await backend.parse_turn("帮我比前两个", current_query="通勤降噪耳机")
    finally:
        await backend.aclose()
    assert act.kind.value == "compare_items"
    assert act.patch is None or act.patch.query is None
