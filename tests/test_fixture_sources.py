"""Fixture 商品源与 Fixed 汇率源测试（Fixture Mode 确定性数据，无外网）。"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.application.errors import UpstreamUnavailableError
from backend.infrastructure.fx_sources.fixed import DEFAULT_RATES, FixedFxSource
from backend.infrastructure.product_sources.fixture import FixtureProductSource

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"

pytestmark = [pytest.mark.contract, pytest.mark.asyncio]


async def test_fixed_fx_returns_deterministic_rate() -> None:
    fx = FixedFxSource()
    snap = await fx.get_rate("USD", "CNY")
    assert snap.rate == DEFAULT_RATES["USD"]
    assert snap.date == "2026-08-14"
    assert snap.source == "fixed-fixture"
    assert snap.base == "USD" and snap.quote == "CNY"


async def test_fixed_fx_missing_currency_raises() -> None:
    fx = FixedFxSource(rates={})
    with pytest.raises(UpstreamUnavailableError) as exc:
        await fx.get_rate("XYZ", "CNY")
    assert exc.value.code == "fx_unavailable"


async def test_fixture_source_reads_market_fixture() -> None:
    src = FixtureProductSource(FIXTURES)
    result = await src.search("sony wh1000xm5", country_code="US", mode="keyword")
    assert len(result.products) > 0
    # 确定性：两次读取结果一致
    again = await src.search("sony wh1000xm5", country_code="US")
    assert [p.id for p in result.products] == [p.id for p in again.products]


async def test_fixture_source_missing_market_returns_empty() -> None:
    src = FixtureProductSource(FIXTURES)
    result = await src.search("q", country_code="XX")
    assert result.products == []
