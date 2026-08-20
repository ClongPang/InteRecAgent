"""进程内任务事件门铃与本轮文本流（实现 MissionEventBroker / RunTextHub）。"""
from __future__ import annotations

import asyncio

from ...application.ports.event_broker import RunTextState


class InProcessMissionEventBroker:
    """按 mission 记录最大序号，唤醒所有等待者。多实例需换成外部 pub/sub。"""

    def __init__(self) -> None:
        self._seqs: dict[str, int] = {}
        self._waiters: dict[str, list[asyncio.Event]] = {}

    def notify(self, mission_id: str, sequence: int) -> None:
        current = self._seqs.get(mission_id, 0)
        if sequence > current:
            self._seqs[mission_id] = sequence
        for waiter in self._waiters.pop(mission_id, []):
            waiter.set()

    async def wait(self, *, mission_id: str, after: int, timeout: float) -> bool:
        if self._seqs.get(mission_id, 0) > after:
            return True
        waiter = asyncio.Event()
        self._waiters.setdefault(mission_id, []).append(waiter)
        if self._seqs.get(mission_id, 0) > after:
            waiter.set()
        try:
            await asyncio.wait_for(waiter.wait(), timeout=timeout)
            return True
        except TimeoutError:
            waiting = self._waiters.get(mission_id, [])
            if waiter in waiting:
                waiting.remove(waiter)
            return False


class _RunBuffer:
    def __init__(self) -> None:
        self.deltas: list[str] = []
        self.text = ""
        self.done = False
        self.aborted = False
        self.waiters: list[asyncio.Event] = []

    def wake(self) -> None:
        for waiter in self.waiters:
            waiter.set()
        self.waiters.clear()


class InProcessRunTextHub:
    """本轮 token 缓冲。完成后短暂保留供晚到的订阅者重放。"""

    def __init__(self) -> None:
        self._runs: dict[str, _RunBuffer] = {}

    def open(self, run_id: str) -> None:
        self._runs[run_id] = _RunBuffer()

    def publish(self, run_id: str, delta: str) -> None:
        if not delta:
            return
        buf = self._runs.get(run_id)
        if buf is None or buf.done:
            return
        buf.deltas.append(delta)
        buf.text += delta
        buf.wake()

    def complete(self, run_id: str, *, text: str | None = None) -> None:
        buf = self._runs.setdefault(run_id, _RunBuffer())
        if buf.done:
            return
        if text and not buf.text:
            buf.deltas.append(text)
            buf.text = text
        buf.done = True
        buf.wake()

    def abort(self, run_id: str) -> None:
        buf = self._runs.setdefault(run_id, _RunBuffer())
        buf.aborted = True
        buf.done = True
        buf.wake()

    def snapshot(self, run_id: str) -> RunTextState | None:
        buf = self._runs.get(run_id)
        if buf is None:
            return None
        return {
            "deltas": list(buf.deltas),
            "text": buf.text,
            "done": buf.done,
            "aborted": buf.aborted,
        }

    async def wait(self, run_id: str, *, after: int, timeout: float) -> bool:
        buf = self._runs.get(run_id)
        if buf is None:
            await asyncio.sleep(min(timeout, 0.2))
            return self._runs.get(run_id) is not None
        if buf.done or len(buf.deltas) > after:
            return True
        waiter = asyncio.Event()
        buf.waiters.append(waiter)
        if buf.done or len(buf.deltas) > after:
            waiter.set()
        try:
            await asyncio.wait_for(waiter.wait(), timeout=timeout)
            return True
        except TimeoutError:
            if waiter in buf.waiters:
                buf.waiters.remove(waiter)
            return False
