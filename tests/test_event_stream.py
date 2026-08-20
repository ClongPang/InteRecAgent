"""写入即推：门铃、本轮文本流、研究进度事件映射。不连库。"""
from __future__ import annotations

import asyncio

import pytest

from backend.application.services.progress import (
    DurableRunProgress,
    public_event_for,
)
from backend.infrastructure.runtime.in_process_broker import (
    InProcessMissionEventBroker,
    InProcessRunTextHub,
)


def test_public_progress_events_are_stable() -> None:
    assert public_event_for("search_products", phase="started") == "search.started"
    assert public_event_for("search_products", phase="finished") == "products.received"
    assert public_event_for("convert_fx", phase="finished") == "fx.received"
    assert public_event_for("rank_candidates", phase="finished") == "candidates.ranked"
    assert public_event_for("filter_candidates", phase="started") is None
    assert public_event_for("finalize", phase="finished") is None


@pytest.mark.asyncio
async def test_broker_wakes_waiter_after_notify() -> None:
    broker = InProcessMissionEventBroker()
    woke = asyncio.Event()

    async def _wait() -> None:
        assert await broker.wait(mission_id="m1", after=0, timeout=2.0)
        woke.set()

    task = asyncio.create_task(_wait())
    await asyncio.sleep(0.05)
    broker.notify("m1", 3)
    await asyncio.wait_for(woke.wait(), timeout=1.0)
    await task


@pytest.mark.asyncio
async def test_broker_wait_returns_immediately_if_already_ahead() -> None:
    broker = InProcessMissionEventBroker()
    broker.notify("m1", 5)
    assert await broker.wait(mission_id="m1", after=2, timeout=0.2) is True


@pytest.mark.asyncio
async def test_text_hub_publishes_then_completes() -> None:
    hub = InProcessRunTextHub()
    hub.open("r1")
    hub.publish("r1", "推荐 ")
    hub.complete("r1", text="推荐 Sony")
    snap = hub.snapshot("r1")
    assert snap is not None
    assert snap["deltas"] == ["推荐 "]
    assert snap["text"] == "推荐 "
    assert snap["done"] is True


@pytest.mark.asyncio
async def test_text_hub_complete_without_prior_publish_uses_full_text() -> None:
    hub = InProcessRunTextHub()
    hub.complete("r2", text="首选是这款。")
    snap = hub.snapshot("r2")
    assert snap is not None
    assert snap["text"] == "首选是这款。"
    assert snap["deltas"] == ["首选是这款。"]


class _FakeEvents:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, dict]] = []

    async def append(self, *, mission_id: str, event_type: str, payload: dict) -> int:
        self.rows.append((mission_id, event_type, payload))
        return len(self.rows)


class _FakeUoW:
    def __init__(self, events: _FakeEvents) -> None:
        self.events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def commit(self) -> None:
        return None


@pytest.mark.asyncio
async def test_durable_progress_writes_public_events_only() -> None:
    events = _FakeEvents()
    progress = DurableRunProgress(lambda: _FakeUoW(events), mission_id="m1", run_id="r1")
    await progress.started("search_products", {"query": "耳机", "markets": ["US"]})
    await progress.finished("search_products", {"count": 4, "markets": ["US"]})
    await progress.finished("filter_candidates", {"kept": 2})
    assert [row[1] for row in events.rows] == ["search.started", "products.received"]
    assert events.rows[0][2]["run_id"] == "r1"
    assert events.rows[1][2]["count"] == 4
