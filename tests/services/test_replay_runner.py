from backend.app.schemas import InternalTrace
from backend.app.services.replay_runner import ReplayRunner


def test_replay_runner_reports_replayed_trace_stages():
    trace = InternalTrace(turn_id="turn_001", session_id="sess_demo", input="hello")

    result = ReplayRunner().replay(trace, "turn_001")

    assert result.replayed is True
    assert result.stages == ["route", "intent", "retrieve", "filter", "verify", "rank", "respond"]


def test_replay_runner_reports_missing_trace_without_claiming_replay():
    result = ReplayRunner().replay(None, "missing_turn")

    assert result.replayed is False
    assert result.turn_id == "missing_turn"
