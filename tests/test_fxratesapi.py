"""FxRatesApiFxSource 契约测试（真实响应 fixture + respx 拦截，无外网）。"""
from __future__ import annotations

import httpx
import pytest
import respx

from backend.application.errors import UpstreamUnavailableError
from backend.infrastructure.fx_sources.fxratesapi import FxRatesApiFxSource

FX_URL = "https://api.fxratesapi.com/latest"

pytestmark = [pytest.mark.contract, pytest.mark.asyncio]


def _fx_fixture() -> dict:
    return {"base": "USD", "date": "2026-08-19T14:54:00.000Z", "rates": {"CNY": 6.7338}}


async def test_parses_real_fixture() -> None:
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(200, json=_fx_fixture()))
        async with FxRatesApiFxSource() as fx:
            snap = await fx.get_rate("USD", "CNY")
        assert snap.base == "USD"
        assert snap.quote == "CNY"
        assert snap.rate == pytest.approx(6.7338)
        # ISO datetime 截成纯日期，与 FixedFxSource/Frankfurter 保持一致
        assert snap.date == "2026-08-19"
        assert snap.source == "fxratesapi"


async def test_requests_currencies_param() -> None:
    with respx.mock:
        route = respx.get(FX_URL).mock(return_value=httpx.Response(200, json=_fx_fixture()))
        async with FxRatesApiFxSource() as fx:
            await fx.get_rate("USD", "CNY")
        params = route.calls[0].request.url.params
        assert params.get("currencies") == "CNY"
        assert params.get("base") == "USD"


async def test_cache_avoids_second_request() -> None:
    with respx.mock:
        route = respx.get(FX_URL).mock(return_value=httpx.Response(200, json=_fx_fixture()))
        async with FxRatesApiFxSource() as fx:
            await fx.get_rate("USD", "CNY")
            await fx.get_rate("USD", "CNY")
        assert len(route.calls) == 1


async def test_same_currency_no_request() -> None:
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(200, json={}))
        async with FxRatesApiFxSource() as fx:
            snap = await fx.get_rate("CNY", "CNY")
        assert snap.rate == 1.0


async def test_missing_quote_raises() -> None:
    with respx.mock:
        respx.get(FX_URL).mock(
            return_value=httpx.Response(
                200, json={"base": "USD", "date": "2026-08-19", "rates": {}}
            )
        )
        async with FxRatesApiFxSource() as fx:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await fx.get_rate("USD", "CNY")
        assert exc.value.code == "fx_missing_rate"


async def test_5xx_retries_then_raises() -> None:
    with respx.mock:
        route = respx.get(FX_URL).mock(return_value=httpx.Response(500))
        async with FxRatesApiFxSource(max_retries=2) as fx:
            with pytest.raises(UpstreamUnavailableError) as exc:
                await fx.get_rate("USD", "CNY")
        assert exc.value.code == "fx_unavailable"
        assert len(route.calls) == 2
