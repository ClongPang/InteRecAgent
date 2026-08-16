from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from backend.adapters.fx import FxError, FrankfurterClient

FIXTURES = Path(__file__).parent / "fixtures" / "buywhere"
FX_URL = "https://api.frankfurter.dev/v1/latest"


def test_parses_real_fixture():
    with respx.mock:
        respx.get(FX_URL).mock(
            return_value=httpx.Response(200, json=json.loads((FIXTURES / "fx_frankfurter.json").read_text()))
        )
        client = FrankfurterClient()
        snap = client.get_rate("USD", "CNY")
        assert snap.base == "USD"
        assert snap.quote == "CNY"
        assert snap.rate == pytest.approx(6.7413)
        assert snap.date == "2026-08-14"
        assert snap.source == "frankfurter-ecb"


def test_cache_avoids_second_request():
    with respx.mock:
        route = respx.get(FX_URL).mock(
            return_value=httpx.Response(200, json=json.loads((FIXTURES / "fx_frankfurter.json").read_text()))
        )
        client = FrankfurterClient()
        client.get_rate("USD", "CNY")
        client.get_rate("USD", "CNY")
        assert len(route.calls) == 1


def test_same_currency_no_request():
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(200, json={}))
        client = FrankfurterClient()
        snap = client.get_rate("CNY", "CNY")
        assert snap.rate == 1.0


def test_missing_quote_raises():
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(200, json={"base": "USD", "date": "2026-08-14", "rates": {}}))
        client = FrankfurterClient()
        with pytest.raises(FxError):
            client.get_rate("USD", "CNY")


def test_upstream_error_raises():
    with respx.mock:
        respx.get(FX_URL).mock(return_value=httpx.Response(500))
        client = FrankfurterClient()
        with pytest.raises(FxError):
            client.get_rate("USD", "CNY")
