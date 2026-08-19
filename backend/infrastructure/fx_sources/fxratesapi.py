"""fxratesapi.com 汇率源（替换 Frankfurter，因 api.frankfurter.dev 当前网络不可达）。

响应与 Frankfurter 同构（{"base","date","rates":{...}}），仅差异：请求参数名
`symbols` → `currencies`，date 为 ISO datetime 而非纯日期。无 key、带汇率日期、
内存 TTL 缓存避免重复请求。
"""
from __future__ import annotations

import time

import httpx
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt

from ...application.errors import UpstreamUnavailableError
from ...domain.models import FxSnapshot, utcnow
from ..retry import is_retryable, retry_wait

FX_BASE = "https://api.fxratesapi.com"
FX_SOURCE = "fxratesapi"


class FxRatesApiFxSource:
    """fxratesapi.com 汇率源（无 key、每日更新、带汇率日期）。"""

    def __init__(
        self,
        *,
        timeout: float = 10.0,
        base_url: str = FX_BASE,
        ttl_seconds: int = 3600,
        client: httpx.AsyncClient | None = None,
        max_retries: int = 3,
    ) -> None:
        self._timeout = timeout
        self._base_url = base_url
        self._ttl = ttl_seconds
        self._max_retries = max_retries
        self._client = client or httpx.AsyncClient(timeout=timeout)
        # (base, quote) -> (FxSnapshot, cached_at_unix)
        self._cache: dict[tuple[str, str], tuple[FxSnapshot, float]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> FxRatesApiFxSource:
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def get_rate(self, base: str, quote: str) -> FxSnapshot:
        key = (base.upper(), quote.upper())
        cached = self._cache.get(key)
        if cached is not None and time.time() - cached[1] < self._ttl:
            return cached[0]
        if base.upper() == quote.upper():
            snap = FxSnapshot(
                base=base.upper(),
                quote=quote.upper(),
                rate=1.0,
                date=utcnow().date().isoformat(),
                source=FX_SOURCE,
            )
            self._cache[key] = (snap, time.time())
            return snap
        snap = await self._fetch(base.upper(), quote.upper())
        self._cache[key] = (snap, time.time())
        return snap

    async def _fetch(self, base: str, quote: str) -> FxSnapshot:
        async for attempt in AsyncRetrying(
            retry=retry_if_exception(is_retryable),
            wait=retry_wait,
            stop=stop_after_attempt(self._max_retries),
            reraise=True,
        ):
            with attempt:
                try:
                    resp = await self._client.get(
                        f"{self._base_url}/latest",
                        params={"base": base, "currencies": quote},
                    )
                except httpx.HTTPError as exc:
                    raise UpstreamUnavailableError(
                        code="fx_unavailable",
                        category="upstream",
                        retryable=True,
                        user_message="无法连接汇率服务",
                    ) from exc
                if resp.status_code >= 500:
                    raise UpstreamUnavailableError(
                        code="fx_unavailable",
                        category="upstream",
                        retryable=True,
                        status_code=resp.status_code,
                    )
                if resp.status_code != 200:
                    raise UpstreamUnavailableError(
                        code="fx_upstream_error",
                        category="upstream",
                        retryable=False,
                        status_code=resp.status_code,
                    )
                try:
                    body = resp.json()
                except ValueError as exc:
                    raise UpstreamUnavailableError(
                        code="fx_parse_error", category="upstream", retryable=True
                    ) from exc
                rates = body.get("rates", {})
                rate = rates.get(quote)
                if rate is None:
                    raise UpstreamUnavailableError(
                        code="fx_missing_rate",
                        category="data",
                        retryable=False,
                        user_message="汇率响应缺少目标币种",
                    )
                # fxratesapi 的 date 是 ISO datetime（如 2026-08-19T14:54:00.000Z），
                # 与 FixedFxSource/Frankfurter 一致，截取纯日期部分。
                date = str(body.get("date") or "")[:10]
                return FxSnapshot(
                    base=base,
                    quote=quote,
                    rate=float(rate),
                    date=date,
                    source=FX_SOURCE,
                )
