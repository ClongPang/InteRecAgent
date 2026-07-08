from time import perf_counter

from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator


def test_fixture_backed_chat_turn_completes_within_local_smoke_threshold():
    orchestrator = ChatOrchestrator()
    request = ChatRequest(
        message="Recommend wireless headphones under 100 dollars for commuting."
    )

    started_at = perf_counter()
    response = orchestrator.run(request)
    elapsed_ms = (perf_counter() - started_at) * 1000

    assert response.status == "recommendations_ready"
    assert response.products
    assert response.trace_summary.retrieved_count > 0
    assert elapsed_ms < 500
