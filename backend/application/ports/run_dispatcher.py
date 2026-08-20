from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class RunDispatcher(Protocol):
    """运行调度 Port。实现：infrastructure/runtime/in_process_dispatcher.py。
    HTTP Command Service 只依赖此 Port（BE-009：禁用 FastAPI BackgroundTasks 承担运行）。"""

    async def start(self) -> None: ...

    async def dispatch(
        self, *, owner_id: str, mission_id: str, run_id: str, constraints_version: int
    ) -> None: ...

    async def cancel(
        self, *, owner_id: str, mission_id: str, run_id: str
    ) -> bool: ...

    async def stop(self, grace_seconds: float = 5.0) -> None: ...
