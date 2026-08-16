from __future__ import annotations

from typing import Protocol, runtime_checkable

from ...domain.models import FxSnapshot


@runtime_checkable
class FxSource(Protocol):
    """汇率源 Port。返回带汇率日期的事实快照。实现：infrastructure/fx_sources/{frankfurter,fixed}.py。"""

    async def get_rate(self, base: str, quote: str) -> FxSnapshot: ...
