from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.trace_logger import InMemoryTraceStore, JsonlTraceStore


def test_in_memory_trace_store_records_filtering_stage():
    response = ChatOrchestrator().run(
        ChatRequest(message="Recommend wireless headphones under 100 dollars.")
    )

    trace = InMemoryTraceStore().write_from_response("Recommend wireless headphones", response)

    assert trace.filtering["input_count"] == response.trace_summary.retrieved_count
    assert trace.filtering["output_count"] == response.trace_summary.filtered_count
    assert trace.filtering["unknown_constraints"][0]["product_id"] == "prod_headphones_002"


def test_jsonl_trace_store_appends_and_reads_by_turn_id(tmp_path):
    path = tmp_path / "traces" / "chat-traces.jsonl"
    store = JsonlTraceStore(path)
    orchestrator = ChatOrchestrator()
    first = orchestrator.run(
        ChatRequest(turn_id="turn_jsonl_001", message="Recommend wireless headphones.")
    )
    second = orchestrator.run(
        ChatRequest(turn_id="turn_jsonl_002", message="Can you check live stock and buy it?")
    )

    store.write_from_response("Recommend wireless headphones.", first)
    store.write_from_response("Can you check live stock and buy it?", second)

    persisted = JsonlTraceStore(path).read("turn_jsonl_002")

    assert persisted is not None
    assert persisted.turn_id == "turn_jsonl_002"
    assert persisted.task_route["task_type"] == "unsupported"
    assert path.read_text(encoding="utf-8").count("\n") == 2


def test_jsonl_trace_store_returns_none_for_missing_turn(tmp_path):
    store = JsonlTraceStore(tmp_path / "missing.jsonl")

    assert store.read("missing_turn") is None
