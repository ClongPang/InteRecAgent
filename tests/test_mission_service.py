"""MissionCommandService 应用服务测试。

通过注入 fake UoW/Dispatcher 验证：只依赖 Application Port、版本冲突被拒绝、
事件在调度前持久化。
"""
from __future__ import annotations

import pytest

from backend.application.dto import MissionConstraints, MissionStage, ShoppingMission, TurnPhase
from backend.application.dto.dialogue import TurnCommand
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

    async def save(
        self, mission: ShoppingMission, *, expected_version: int | None = None
    ) -> None:
        current = self.missions.get(mission.id)
        if expected_version is not None and current is not None:
            if current.constraints_version != expected_version:
                raise MissionVersionConflict("version mismatch")
        self.missions[mission.id] = mission


class FakeEvents:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict]] = []

    async def append(self, *, mission_id: str, event_type: str, payload: dict) -> int:
        self.events.append((mission_id, event_type, payload))
        return len(self.events)

    async def list_since(self, *, mission_id: str, sequence: int = 0) -> list[dict]:
        out: list[dict] = []
        for index, (mid, event_type, payload) in enumerate(self.events, start=1):
            if mid == mission_id and index > sequence:
                out.append({"sequence": index, "event_type": event_type, "payload": payload})
        return out


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
    assert missions.missions["m1"].stage.value == "collecting"
    assert missions.missions["m1"].turn_phase.value == "responding"
    assert missions.missions["m1"].active_run_id == run_id


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


@pytest.mark.asyncio
async def test_update_constraints_dispatches_new_version() -> None:
    """命令层先写入新版本，调度必须带着新版本，否则 persist 会误判 superseded。"""
    svc, missions, events, dispatcher = _make(version=2)
    missions.missions["m1"] = missions.missions["m1"].model_copy(
        update={"constraints": MissionConstraints(query="降噪耳机", budget_cny=4000)}
    )
    run_id, version = await svc.update_constraints(
        owner_id="u1",
        mission_id="m1",
        constraints_version=2,
        constraints=MissionConstraints(query="降噪耳机", budget_cny=3000),
    )
    assert dispatcher.calls[0][2] == run_id
    assert dispatcher.calls[0][3] == 3
    assert version == 3
    assert missions.missions["m1"].constraints_version == 3
    assert missions.missions["m1"].constraints.budget_cny == 3000
    assert events.events[0][1] == "constraints.updated"
    assert missions.missions["m1"].turn_phase.value == "researching"


@pytest.mark.asyncio
async def test_update_constraints_unchanged_keeps_version() -> None:
    """PATCH 内容与当前相同：不递增版本，也不调度。"""
    current = MissionConstraints(query="降噪耳机", budget_cny=4000)
    svc, missions, events, dispatcher = _make(
        version=2,
        mission=_mission(version=2).model_copy(update={"constraints": current}),
    )
    _run_id, version = await svc.update_constraints(
        owner_id="u1",
        mission_id="m1",
        constraints_version=2,
        constraints=current,
    )
    assert version == 2
    assert dispatcher.calls == []
    assert missions.missions["m1"].constraints_version == 2
    assert events.events[-1][1] == "agent.message"


@pytest.mark.asyncio
async def test_get_thread_projects_user_message() -> None:
    svc, missions, events, dispatcher = _make()
    await events.append(
        mission_id="m1", event_type="message.received", payload={"text": "降噪耳机", "constraints_version": 1}
    )
    view = await svc.get_thread(owner_id="u1", mission_id="m1")
    assert len(view.messages) == 1
    assert view.messages[0].kind == "user"
    assert view.messages[0].text == "降噪耳机"


@pytest.mark.asyncio
async def test_submit_question_does_not_mark_searching() -> None:
    mission = _mission(version=1).model_copy(
        update={
            "stage": MissionStage.READY,
            "constraints": MissionConstraints(query="降噪耳机", budget_cny=4000),
        }
    )
    svc, missions, events, dispatcher = _make(mission=mission)
    run_id = await svc.submit_message(
        owner_id="u1", mission_id="m1", text="这款保修吗", constraints_version=1
    )
    assert dispatcher.calls[0][2] == run_id
    stored = missions.missions["m1"]
    assert stored.stage == MissionStage.READY
    assert stored.turn_phase == TurnPhase.RESPONDING


@pytest.mark.asyncio
async def test_chat_undo_does_not_dispatch_search_run() -> None:
    mission = _mission(version=2).model_copy(
        update={"constraints": MissionConstraints(query="降噪耳机", budget_cny=4000)}
    )
    svc, missions, events, dispatcher = _make(mission=mission, version=2)
    await events.append(
        mission_id="m1",
        event_type="constraints.updated",
        payload={
            "before": MissionConstraints(query="降噪耳机", budget_cny=2000).model_dump(mode="json"),
            "after": MissionConstraints(query="降噪耳机", budget_cny=4000).model_dump(mode="json"),
        },
    )
    run_id = await svc.submit_message(
        owner_id="u1", mission_id="m1", text="撤销刚才的条件", constraints_version=2
    )
    assert [item[1] for item in events.events] == ["constraints.updated", "message.received", "constraints.undo"]
    assert len(dispatcher.calls) == 1
    assert dispatcher.calls[0][2] == run_id
    assert events.events[1][2].get("run_id") is None
    assert missions.missions["m1"].constraints.budget_cny == 2000


@pytest.mark.asyncio
async def test_stance_keeps_query_and_tightens_budget() -> None:
    mission = _mission(version=1).model_copy(
        update={
            "stage": MissionStage.READY,
            "constraints": MissionConstraints(query="降噪耳机", budget_cny=4000),
        }
    )
    svc, missions, events, dispatcher = _make(mission=mission)
    run_id = await svc.submit_message(
        owner_id="u1", mission_id="m1", text="太贵了", constraints_version=1
    )
    stored = missions.missions["m1"]
    assert stored.constraints.query == "降噪耳机"
    assert stored.constraints.budget_cny == 3200
    assert stored.constraints_version == 2
    assert stored.dialogue.stance == "too_expensive"
    assert dispatcher.calls[0][2] == run_id
    assert dispatcher.calls[0][3] == 2
    assert events.events[1][1] == "constraints.updated"


@pytest.mark.asyncio
async def test_patch_in_stock_dispatches_refilter() -> None:
    mission = _mission(version=1).model_copy(
        update={"constraints": MissionConstraints(query="降噪耳机", budget_cny=4000)}
    )
    svc, missions, events, dispatcher = _make(mission=mission)
    _run_id, version = await svc.update_constraints(
        owner_id="u1",
        mission_id="m1",
        constraints_version=1,
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000, only_in_stock=True),
    )
    assert version == 2
    assert dispatcher.calls
    assert missions.missions["m1"].constraints.only_in_stock is True
    assert events.events[-1][1] == "constraints.updated"


@pytest.mark.asyncio
async def test_patch_noise_on_non_audio_does_not_dispatch() -> None:
    mission = _mission(version=1).model_copy(
        update={"constraints": MissionConstraints(query="4K 显示器", budget_cny=4000)}
    )
    svc, missions, events, dispatcher = _make(mission=mission)
    _run_id, version = await svc.update_constraints(
        owner_id="u1",
        mission_id="m1",
        constraints_version=1,
        constraints=MissionConstraints(query="4K 显示器", budget_cny=4000, preference="noise"),
    )
    assert version == 1
    assert dispatcher.calls == []
    assert missions.missions["m1"].constraints.preference == "balanced"
    assert events.events[-1][1] == "agent.message"


@pytest.mark.asyncio
async def test_submit_message_stores_focus_snapshot() -> None:
    mission = _mission(version=1).model_copy(
        update={
            "stage": MissionStage.READY,
            "constraints": MissionConstraints(query="降噪耳机", budget_cny=4000),
        }
    )
    svc, missions, _events, _dispatcher = _make(mission=mission)
    await svc.submit_message(
        owner_id="u1",
        mission_id="m1",
        text="这款保修吗",
        constraints_version=1,
        focus_snapshot_id="snap-9",
    )
    assert missions.missions["m1"].dialogue.focus_snapshot_id == "snap-9"


@pytest.mark.asyncio
async def test_submit_turn_message_matches_send() -> None:
    mission = _mission(version=1).model_copy(
        update={"constraints": MissionConstraints(query="降噪耳机", budget_cny=4000)}
    )
    svc, missions, _events, dispatcher = _make(mission=mission)
    run_id = await svc.submit_turn(
        owner_id="u1",
        mission_id="m1",
        constraints_version=1,
        command=TurnCommand.MESSAGE,
        text="这款保修吗",
        focus_snapshot_id="snap-9",
    )
    assert dispatcher.calls[0][2] == run_id
    assert missions.missions["m1"].dialogue.focus_snapshot_id == "snap-9"
