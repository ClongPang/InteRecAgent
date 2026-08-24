"""LangGraph MissionRunner 实现（实现 MissionRunner Port，AGT-001）。"""
from __future__ import annotations

from typing import Any

from ..application.dto import RunnerResult, RunnerStatus
from .state import MissionGraphState


class LangGraphMissionRunner:
    """用 LangGraph 状态图编排一次运行。checkpoint 只记录图位置，业务事实由仓储持久化。"""

    def __init__(self, graph, *, feature_flags: dict | None = None) -> None:
        self._graph = graph
        self._feature_flags = dict(feature_flags or {})

    def release_metadata(self, mission_id: str) -> dict[str, Any]:
        del mission_id
        return {"feature_flags": dict(self._feature_flags)}

    async def run(
        self,
        *,
        owner_id: str,
        mission_id: str,
        run_id: str,
        constraints_version: int,
    ) -> RunnerResult:
        initial: MissionGraphState = {
            "owner_id": owner_id,
            "mission_id": mission_id,
            "run_id": run_id,
            "run_version": constraints_version,
            "feature_flags": self._feature_flags,
        }
        final = await self._graph.ainvoke(initial)
        return RunnerResult(
            status=final.get("status", RunnerStatus.FAILED),
            candidate_set_id=final.get("candidate_set_id"),
            recommendation_run_id=final.get("recommendation_run_id"),
            warnings=final.get("warnings", []),
            metadata={"feature_flags": self._feature_flags},
        )
