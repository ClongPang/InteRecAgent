from __future__ import annotations

from typing import Protocol, runtime_checkable

from .repositories import (
    CandidateSetRepository,
    FxSnapshotRepository,
    MissionEventRepository,
    MissionRepository,
    ProductSnapshotRepository,
    RecommendationRunRepository,
)


@runtime_checkable
class UnitOfWork(Protocol):
    """事务边界 Port。P2 的 asyncpg + SQLAlchemy 实现保证 Mission Event 与
    constraints_version 原子提交（DAT-005）。节点通过这里访问会话绑定仓储。"""

    missions: MissionRepository
    events: MissionEventRepository
    products: ProductSnapshotRepository
    fx_snapshots: FxSnapshotRepository
    candidate_sets: CandidateSetRepository
    recommendation_runs: RecommendationRunRepository

    async def __aenter__(self) -> UnitOfWork: ...

    async def __aexit__(self, exc_type, exc, tb) -> None: ...

    async def commit(self) -> None: ...

    async def rollback(self) -> None: ...
