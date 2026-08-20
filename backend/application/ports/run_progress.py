from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class RunProgress(Protocol):
    """研究步骤进度。实现写成 durable 事件，提交后由门铃唤醒 SSE。"""

    async def started(self, tool: str, payload: dict) -> None: ...

    async def finished(self, tool: str, payload: dict) -> None: ...
