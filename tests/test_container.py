"""组合根测试（ARC-006/ARC-007、P1-W03 门禁）。

- Fixture Mode 无 Key 装配离线源；
- Live Mode 缺 Key 时启动失败信息明确且不泄露 Key 值。
"""
from __future__ import annotations

import os

import pytest

from backend.bootstrap.container import ConfigurationError, Container
from backend.bootstrap.settings import Settings
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.fx_sources.fxratesapi import FxRatesApiFxSource
from backend.infrastructure.llm.openai_compat import OpenAICompatModelBackend
from backend.infrastructure.llm.unconfigured import UnconfiguredModelBackend
from backend.infrastructure.product_sources.buywhere import BuyWhereProductSource
from backend.infrastructure.product_sources.fixture import FixtureProductSource


def _settings(**overrides) -> Settings:
    defaults = {"llm_provider": "unconfigured", "llm_api_key": ""}
    defaults.update(overrides)
    return Settings(**defaults)


def test_fixture_mode_builds_offline_sources() -> None:
    c = Container(_settings(data_source="fixture"))
    assert isinstance(c.build_product_source(), FixtureProductSource)
    assert isinstance(c.build_fx_source(), FixedFxSource)


def test_live_mode_without_key_raises_clear_error() -> None:
    c = Container(_settings(data_source="live", buywhere_api_key=""))
    with pytest.raises(ConfigurationError) as exc:
        c.build_product_source()
    msg = str(exc.value)
    assert "INTEREC_BUYWHERE_API_KEY" in msg  # 明确提示所需变量名
    assert "fixture" in msg  # 给出可执行建议


def test_live_mode_error_does_not_contain_secret_value() -> None:
    # 缺失 Key 的错误消息必须是固定模板，不含任何动态/秘密值
    c = Container(_settings(data_source="live", buywhere_api_key=""))
    with pytest.raises(ConfigurationError) as exc:
        c.build_product_source()
    assert str(exc.value) == (
        "data_source=live 需要 INTEREC_BUYWHERE_API_KEY；未配置 Key 时请使用默认 fixture 模式"
    )


def test_live_mode_with_key_builds_real_source() -> None:
    c = Container(_settings(data_source="live", buywhere_api_key="test-key-123"))
    assert isinstance(c.build_product_source(), BuyWhereProductSource)
    assert isinstance(c.build_fx_source(), FxRatesApiFxSource)


def test_dispatcher_is_shared_with_command_service() -> None:
    c = Container(_settings(data_source="fixture"))
    sf = c.build_session_factory()
    first = c.build_run_dispatcher(sf)
    service = c.build_command_service(sf)
    assert c.build_run_dispatcher(sf) is first
    assert service._dispatcher is first
    assert service._broker is c.build_event_broker()
    assert service._text_hub is c.build_text_hub()


def test_settings_reads_interec_env_vars() -> None:
    os.environ["INTEREC_DATA_SOURCE"] = "live"
    os.environ["INTEREC_BUYWHERE_API_KEY"] = "env-key"
    try:
        s = Settings()
        assert s.data_source == "live"
        assert s.buywhere_api_key == "env-key"
    finally:
        del os.environ["INTEREC_DATA_SOURCE"]
        del os.environ["INTEREC_BUYWHERE_API_KEY"]


def test_unconfigured_model_backend_is_default() -> None:
    c = Container(_settings(llm_provider="unconfigured", llm_api_key=""))
    assert isinstance(c.build_model_backend(), UnconfiguredModelBackend)


def test_openai_compat_without_key_raises_clear_error() -> None:
    c = Container(_settings(llm_provider="openai_compat", llm_api_key=""))
    with pytest.raises(ConfigurationError) as exc:
        c.build_model_backend()
    msg = str(exc.value)
    assert "INTEREC_LLM_API_KEY" in msg
    assert "unconfigured" in msg


def test_deepseek_provider_builds_official_compat_backend() -> None:
    c = Container(
        _settings(
            llm_provider="deepseek",
            llm_api_key="sk-test",
            llm_base_url="https://api.deepseek.com",
            llm_model="deepseek-v4-flash",
        )
    )
    backend = c.build_model_backend()
    assert isinstance(backend, OpenAICompatModelBackend)
    assert backend.is_configured() is True


def test_unknown_llm_provider_raises() -> None:
    c = Container(_settings(llm_provider="claude", llm_api_key="sk-test"))
    with pytest.raises(ConfigurationError, match="暂未实现"):
        c.build_model_backend()


def test_settings_legacy_key_alias() -> None:
    os.environ["BUYWHERE_API_KEY"] = "legacy-key"
    try:
        assert Settings().buywhere_api_key == "legacy-key"
    finally:
        del os.environ["BUYWHERE_API_KEY"]
