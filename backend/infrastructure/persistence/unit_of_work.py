from __future__ import annotations

from typing import Self

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...application.ports.event_broker import MissionEventBroker
from .repositories import (
    PostgresCandidateSetRepository,
    PostgresFxSnapshotRepository,
    PostgresIdempotencyRepository,
    PostgresMissionEventRepository,
    PostgresMissionRepository,
    PostgresProductSnapshotRepository,
    PostgresRecommendationRunRepository,
)


class _NotifyingEventRepository:
    """记录本事务追加的序号；提交成功后再敲门铃，避免读到未提交行。"""

    def __init__(self, inner: PostgresMissionEventRepository, pending: list[tuple[str, int]]) -> None:
        self._inner = inner
        self._pending = pending

    async def append(self, *, mission_id: str, event_type: str, payload: dict) -> int:
        sequence = await self._inner.append(
            mission_id=mission_id, event_type=event_type, payload=payload
        )
        self._pending.append((mission_id, sequence))
        return sequence

    async def list_since(self, *, mission_id: str, sequence: int = 0) -> list[dict]:
        return await self._inner.list_since(mission_id=mission_id, sequence=sequence)


class SqlAlchemyUnitOfWork:
    """事务边界实现（DAT-005）。保证 Mission Event 与 constraints_version 更新原子提交。

    提交成功后若注入了 EventBroker，按本事务追加的序号敲门铃；SSE 醒来后仍 ``list_since``。
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        broker: MissionEventBroker | None = None,
    ) -> None:
        self._factory = session_factory
        self._broker = broker
        self._session: AsyncSession | None = None
        self._pending: list[tuple[str, int]] = []

        self.missions: PostgresMissionRepository
        self.events: PostgresMissionEventRepository | _NotifyingEventRepository
        self.products: PostgresProductSnapshotRepository
        self.fx_snapshots: PostgresFxSnapshotRepository
        self.candidate_sets: PostgresCandidateSetRepository
        self.recommendation_runs: PostgresRecommendationRunRepository
        self.idempotency: PostgresIdempotencyRepository

    async def __aenter__(self) -> Self:
        self._session = self._factory()
        self._pending = []
        self.missions = PostgresMissionRepository(self._session)
        inner_events = PostgresMissionEventRepository(self._session)
        self.events = (
            _NotifyingEventRepository(inner_events, self._pending) if self._broker else inner_events
        )
        self.products = PostgresProductSnapshotRepository(self._session)
        self.fx_snapshots = PostgresFxSnapshotRepository(self._session)
        self.candidate_sets = PostgresCandidateSetRepository(self._session)
        self.recommendation_runs = PostgresRecommendationRunRepository(self._session)
        self.idempotency = PostgresIdempotencyRepository(self._session)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None and self._session is not None:
            self._pending.clear()
            await self._session.rollback()
        if self._session is not None:
            await self._session.close()
        self._session = None

    async def commit(self) -> None:
        assert self._session is not None
        await self._session.commit()
        pending = list(self._pending)
        self._pending.clear()
        if self._broker is not None:
            for mission_id, sequence in pending:
                self._broker.notify(mission_id, sequence)

    async def rollback(self) -> None:
        assert self._session is not None
        self._pending.clear()
        await self._session.rollback()
