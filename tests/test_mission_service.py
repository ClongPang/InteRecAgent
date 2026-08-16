"""MissionCommandService 应用服务测试。

通过注入 fake UoW/Dispatcher 验证：只依赖 Application Port、版本冲突被拒绝、
事件在调度前持久化。
"""
from __future__ import annotations

import pytest

from backend.application.dto import ShoppingMission
from backend.application.errors import MissionNotFound, MissionVersionConflict
from backend.application.services import MissionCommandService


def _mission(version: int = 1) -> ShoppingMission:
    return ShoppingMission(id="m1", owner_id="u1", title="测试任务", constraints_version=version)


class FakeMissions:
    def __init__(self, missions: dict[str, ShoppingMission]) -> None:
        self.missions = missions

    async def get(self, *, owner_id: str, mission_id: str) -> ShoppingMission | None:
        return self.missions.get(mission_id)

    async def create(self, *, owner_id: str, title: str) -> ShoppingMission:
        m = ShoppingMission(id="new-1", owner_id=owner_id, title=title)
        self.missions[m.id] = m
        return m

    async def save(self, mission: ShoppingMission) -> None:
        self.missions[mission.id] = mission


class FakeEvents:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict]] = []

    async def append(self, *, mission_id: str, event_type: str, payload: dict) -> int:
        self.events.append((mission_id, event_type, payload))
        return len(self.events)


class FakeUoW:
    def __init__(self, missions: FakeMissions, events: FakeEvents) -> None:
        self.missions = missions
        self.events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass


class FakeDispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, int]] = []

    async def start(self) -> None:
        pass

    async def dispatch(self, *, owner_id: str, mission_id: str, run_id: str, constraints_version: int) -> None:
        self.calls.append((owner_id, mission_id, run_id, constraints_version))

    async def stop(self, grace_seconds: float = 5.0) -> None:
        pass


def _make(
    mission: ShoppingMission | None = None, version: int = 1
) -> tuple[MissionCommandService, FakeMissions, FakeEvents, FakeDispatcher]:
    m = mission or _mission(version=version)
    missions = FakeMissions({"m1": m})
    events = FakeEvents()
    dispatcher = FakeDispatcher()
    svc = MissionCommandService(uow_factory=lambda: FakeUoW(missions, events), dispatcher=dispatcher)
    return svc, missions, events, dispatcher


@pytest.mark.asyncio
async def test_submit_message_dispatches_and_returns_run_id() -> None:
    svc, missions, events, dispatcher = _make()
    run_id = await svc.submit_message(
        owner_id="u1", mission_id="m1", text="预算 2000", constraints_version=1
    )
    assert isinstance(run_id, str) and run_id
    assert len(dispatcher.calls) == 1
    owner, mid, dispatched_run_id, version = dispatcher.calls[0]
    assert owner == "u1" and mid == "m1"
    assert dispatched_run_id == run_id
    assert version == 1
    # 事件已持久化（先于调度，保证可追溯）
    assert events.events[0][1] == "message.received"
    assert events.events[0][2]["run_id"] == run_id


@pytest.mark.asyncio
async def test_version_mismatch_raises_conflict() -> None:
    svc, missions, events, dispatcher = _make(version=2)
    with pytest.raises(MissionVersionConflict):
        await svc.submit_message(
            owner_id="u1", mission_id="m1", text="x", constraints_version=1
        )
    assert dispatcher.calls == []


@pytest.mark.asyncio
async def test_get_missing_mission_raises_not_found() -> None:
    svc, missions, events, dispatcher = _make()
    with pytest.raises(MissionNotFound):
        await svc.get_mission(owner_id="u1", mission_id="nope")


@pytest.mark.asyncio
async def test_create_mission_persists() -> None:
    svc, missions, events, dispatcher = _make()
    mission = await svc.create_mission(owner_id="u1", title="通勤降噪耳机")
    assert mission.owner_id == "u1"
    assert mission.constraints_version == 1
    assert missions.missions["new-1"].title == "通勤降噪耳机"
