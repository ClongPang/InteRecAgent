from __future__ import annotations

from typing import Self

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .repositories import (
    PostgresCandidateSetRepository,
    PostgresFxSnapshotRepository,
    PostgresIdempotencyRepository,
    PostgresMissionEventRepository,
    PostgresMissionRepository,
    PostgresProductSnapshotRepository,
    PostgresRecommendationRunRepository,
)


class SqlAlchemyUnitOfWork:
    """事务边界实现（DAT-005）。保证 Mission Event 与 constraints_version 更新原子提交。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = session_factory
        self._session: AsyncSession | None = None

        self.missions: PostgresMissionRepository
        self.events: PostgresMissionEventRepository
        self.products: PostgresProductSnapshotRepository
        self.fx_snapshots: PostgresFxSnapshotRepository
        self.candidate_sets: PostgresCandidateSetRepository
        self.recommendation_runs: PostgresRecommendationRunRepository
        self.idempotency: PostgresIdempotencyRepository

    async def __aenter__(self) -> Self:
        self._session = self._factory()
        self.missions = PostgresMissionRepository(self._session)
        self.events = PostgresMissionEventRepository(self._session)
        self.products = PostgresProductSnapshotRepository(self._session)
        self.fx_snapshots = PostgresFxSnapshotRepository(self._session)
        self.candidate_sets = PostgresCandidateSetRepository(self._session)
        self.recommendation_runs = PostgresRecommendationRunRepository(self._session)
        self.idempotency = PostgresIdempotencyRepository(self._session)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None and self._session is not None:
            await self._session.rollback()
        if self._session is not None:
            await self._session.close()
        self._session = None

    async def commit(self) -> None:
        assert self._session is not None
        await self._session.commit()

    async def rollback(self) -> None:
        assert self._session is not None
        await self._session.rollback()
