"""研究工具 → 公开进度事件。payload 只带摘要，不塞商品目录。"""
from __future__ import annotations

from collections.abc import Callable

from ..ports import UnitOfWork

STARTED_EVENTS = {
    "search_products": "search.started",
}

FINISHED_EVENTS = {
    "search_products": "products.received",
    "convert_fx": "fx.received",
    "rank_candidates": "candidates.ranked",
}


def public_event_for(tool: str, *, phase: str) -> str | None:
    if phase == "started":
        return STARTED_EVENTS.get(tool)
    if phase == "finished":
        return FINISHED_EVENTS.get(tool)
    return None


class DurableRunProgress:
    """短事务追加进度事件。提交后 UoW 敲门铃，SSE 立刻重读。"""

    def __init__(
        self,
        uow_factory: Callable[[], UnitOfWork],
        *,
        mission_id: str,
        run_id: str,
    ) -> None:
        self._uow_factory = uow_factory
        self._mission_id = mission_id
        self._run_id = run_id

    async def started(self, tool: str, payload: dict) -> None:
        await self._emit(public_event_for(tool, phase="started"), payload)

    async def finished(self, tool: str, payload: dict) -> None:
        await self._emit(public_event_for(tool, phase="finished"), payload)

    async def _emit(self, event_type: str | None, payload: dict) -> None:
        if not event_type:
            return
        body = {"run_id": self._run_id, **payload}
        async with self._uow_factory() as uow:
            await uow.events.append(
                mission_id=self._mission_id,
                event_type=event_type,
                payload=body,
            )
            await uow.commit()
