from __future__ import annotations

from backend.app.schemas import InternalTrace, ReplayResult


REPLAY_STAGES = ["route", "intent", "retrieve", "filter", "verify", "rank", "respond"]


class ReplayRunner:
    def replay(self, trace: InternalTrace | None, turn_id: str) -> ReplayResult:
        return ReplayResult(
            turn_id=trace.turn_id if trace else turn_id,
            replayed=trace is not None,
            stages=REPLAY_STAGES,
        )
