from __future__ import annotations

from typing import Protocol, runtime_checkable

from ...domain.models import FxSnapshot, NormalizedProduct
from ..dto import ShoppingMission


@runtime_checkable
class MissionRepository(Protocol):
    """任务仓储 Port。只返回应用 DTO；不暴露 ORM Model。"""

    async def get(self, *, owner_id: str, mission_id: str) -> ShoppingMission | None: ...

    async def list(
        self, *, owner_id: str, limit: int = 20, offset: int = 0
    ) -> list[ShoppingMission]: ...

    async def create(self, *, owner_id: str, title: str) -> ShoppingMission: ...

    async def save(self, mission: ShoppingMission) -> None: ...


@runtime_checkable
class MissionEventRepository(Protocol):
    """任务事件仓储 Port。事件用于审计、SSE 推送与约束版本可追溯。"""

    async def append(
        self, *, mission_id: str, event_type: str, payload: dict
    ) -> int: ...  # 返回递增 sequence

    async def list_since(
        self, *, mission_id: str, sequence: int = 0
    ) -> list[dict]: ...


@runtime_checkable
class ProductSnapshotRepository(Protocol):
    """商品快照仓储 Port。原始 payload 只存受控 JSONB，不返回给 API。"""

    async def save(
        self, *, product: NormalizedProduct, raw_payload: dict, contract_version: str
    ) -> str: ...

    async def get(self, snapshot_id: str) -> dict | None: ...


@runtime_checkable
class FxSnapshotRepository(Protocol):
    async def save(self, *, snapshot: FxSnapshot) -> str: ...


@runtime_checkable
class CandidateSetRepository(Protocol):
    """候选集仓储 Port。保存保留/排除原因、排序位置与确定性评分输入。"""

    async def save(self, *, mission_id: str, run_id: str, constraints_version: int, payload: dict) -> str: ...

    async def get(self, candidate_set_id: str) -> dict | None: ...


@runtime_checkable
class RecommendationRunRepository(Protocol):
    async def save(self, *, mission_id: str, run_id: str, payload: dict) -> None: ...

    async def mark_superseded(self, *, mission_id: str, run_id: str) -> None: ...

    async def interrupt_stale(self) -> int: ...

    async def get(self, run_id: str) -> dict | None: ...


@runtime_checkable
class IdempotencyRepository(Protocol):
    async def get(self, *, owner_id: str, key: str) -> dict | None: ...

    async def save(self, *, owner_id: str, key: str, payload: dict) -> None: ...
