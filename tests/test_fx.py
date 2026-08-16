"""FrankfurterFxSource 契约测试（真实响应 fixture + respx 拦截，无外网）。"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from backend.application.errors import UpstreamUnavailableError
from backend.infrastructure.fx_sources.frankfurter import FrankfurterFxSource

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"
FX_URL = "https://api.frankfurter.dev/v1/latest"

pytestmark = [pytest.mark.contract, pytest.mark.asyncio]


def _fx_fixture() -> dict:
    return json.loads((FIXTURES / "fx_frankfurter.json").read_text(encoding="utf-8"))


async def test_parses_real_fixture() -> None:
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(200, json=_fx_fixture()))
        async with FrankfurterFxSource() as fx:
            snap = await fx.get_rate("USD", "CNY")
        assert snap.base == "USD"
        assert snap.quote == "CNY"
        assert snap.rate == pytest.approx(6.7413)
        assert snap.date == "2026-08-14"
        assert snap.source == "frankfurter-ecb"


async def test_cache_avoids_second_request() -> None:
    with respx.mock:
        route = respx.get(FX_URL).mock(return_value=httpx.Response(200, json=_fx_fixture()))
        async with FrankfurterFxSource() as fx:
            await fx.get_rate("USD", "CNY")
            await fx.get_rate("USD", "CNY")
        assert len(route.calls) == 1


async def test_same_currency_no_request() -> None:
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(200, json={}))
        async with FrankfurterFxSource() as fx:
            snap = await fx.get_rate("CNY", "CNY")
        assert snap.rate == 1.0


async def test_missing_quote_raises() -> None:
    with respx.mock:
        respx.get(FX_URL).mock(
            return_value=httpx.Response(200, json={"base": "USD", "date": "2026-08-14", "rates": {}})
        )
        async with FrankfurterFxSource() as fx:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await fx.get_rate("USD", "CNY")
        assert exc.value.code == "fx_missing_rate"


async def test_5xx_retries_then_raises() -> None:
    with respx.mock:
        route = respx.get(FX_URL).mock(return_value=httpx.Response(500))
        async with FrankfurterFxSource(max_retries=2) as fx:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await fx.get_rate("USD", "CNY")
        assert exc.value.code == "fx_unavailable"
        assert len(route.calls) == 2
