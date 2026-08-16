from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..dto import RunnerResult


@runtime_checkable
class MissionRunner(Protocol):
    """任务编排 Port。实现：agent/LangGraphMissionRunner。
    一次 run 消费 mission 当前状态并产生 RunnerResult；不承担任务持久化。"""

    async def run(
        self,
        *,
        owner_id: str,
        mission_id: str,
        run_id: str,
        constraints_version: int,
    ) -> RunnerResult: ...
