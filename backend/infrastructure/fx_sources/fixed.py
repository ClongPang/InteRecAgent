from __future__ import annotations

from ...application.errors import UpstreamUnavailableError
from ...domain.models import FxSnapshot

# 实测中的代表性汇率（Fixture Mode 用，不声称是实时值）
DEFAULT_RATES: dict[str, float] = {
    "USD": 7.1882,
    "SGD": 5.3083,
    "MYR": 1.5500,
    "THB": 0.2080,
    "VND": 0.00029,
}


class FixedFxSource:
    """确定性汇率源。Fixture Mode 使用，不访问外网。"""

    def __init__(
        self,
        rates: dict[str, float] | None = None,
        *,
        rate_date: str = "2026-08-14",
        source: str = "fixed-fixture",
    ) -> None:
        self._rates = dict(rates or DEFAULT_RATES)
        self._rate_date = rate_date
        self._source = source

    async def get_rate(self, base: str, quote: str) -> FxSnapshot:
        base = base.upper()
        quote = quote.upper()
        if base == quote:
            return FxSnapshot(
                base=base, quote=quote, rate=1.0, date=self._rate_date, source=self._source
            )
        rate = self._rates.get(base)
        if rate is None:
            raise UpstreamUnavailableError(
                code="fx_unavailable",
                category="upstream",
                retryable=False,
                user_message=f"固定汇率源缺少币种 {base}",
            )
        return FxSnapshot(
            base=base, quote=quote, rate=rate, date=self._rate_date, source=self._source
        )
