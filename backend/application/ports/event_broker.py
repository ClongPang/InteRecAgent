from __future__ import annotations

from typing import Protocol, TypedDict, runtime_checkable


class RunTextState(TypedDict):
    deltas: list[str]
    text: str
    done: bool
    aborted: bool


@runtime_checkable
class MissionEventBroker(Protocol):
    """任务事件门铃。只唤醒订阅方，不承载 payload。

    真相仍是 ``mission_events``。实现可换成 Redis / LISTEN-NOTIFY，
    订阅方被唤醒后必须 ``list_since`` 重读。
    """

    def notify(self, mission_id: str, sequence: int) -> None: ...

    async def wait(self, *, mission_id: str, after: int, timeout: float) -> bool: ...


@runtime_checkable
class RunTextHub(Protocol):
    """本轮 ephemeral token 流。终稿仍以 ``agent.message`` 事件为准。"""

    def open(self, run_id: str) -> None: ...

    def publish(self, run_id: str, delta: str) -> None: ...

    def complete(self, run_id: str, *, text: str | None = None) -> None: ...

    def abort(self, run_id: str) -> None: ...

    def snapshot(self, run_id: str) -> RunTextState | None: ...

    async def wait(self, run_id: str, *, after: int, timeout: float) -> bool: ...
