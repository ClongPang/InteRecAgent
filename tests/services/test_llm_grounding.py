import pytest

from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.constraint_verifier import ConstraintVerifier
from backend.app.services.intent_parser import IntentParser
from backend.app.services.llm_adapter import LLMAdapter, LLMAdapterError, RerankPlan
from backend.app.services.llm_reranker import LLMReranker
from backend.app.services.product_store import ProductStore
from backend.app.services.response_generator import GroundedResponseGenerator
from backend.app.services.retriever import Retriever
from backend.app.services.task_router import TaskRouter
from backend.app.services.trace_logger import InMemoryTraceStore


def test_llm_adapter_rejects_invalid_schema_output(monkeypatch):
    adapter = LLMAdapter(mode="mock")
    monkeypatch.setattr(adapter, "_raw_response", lambda _prompt: {"bad": "shape"})

    with pytest.raises(LLMAdapterError):
        adapter.generate_json("rerank", RerankPlan)


def test_llm_adapter_cached_mode_reuses_schema_valid_response():
    adapter = LLMAdapter(mode="cached")

    first = adapter.generate_json("rerank these safe items", RerankPlan)
    second = adapter.generate_json("rerank these safe items", RerankPlan)

    assert first == second
    assert len(adapter.cache) == 1


def test_llm_adapter_live_mode_uses_openai_compatible_transport():
    captured_payload = {}

    def fake_transport(payload):
        captured_payload.update(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"ordered_product_ids":["prod_headphones_001"],"rationale":"live transport"}'
                    }
                }
            ]
        }

    adapter = LLMAdapter(mode="live", model="deepseek-v4-flash", transport=fake_transport)

    plan = adapter.generate_json("rerank only safe products", RerankPlan)

    assert captured_payload["model"] == "deepseek-v4-flash"
    assert captured_payload["response_format"] == {"type": "json_object"}
    assert plan.ordered_product_ids == ["prod_headphones_001"]
    assert plan.rationale == "live transport"


def test_llm_adapter_live_mode_reads_model_from_dotenv(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("DeepSeek_MODEL=deepseek-v4-flash\n", encoding="utf-8")
    captured_payload = {}

    def fake_transport(payload):
        captured_payload.update(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"ordered_product_ids":[],"rationale":"dotenv model"}'
                    }
                }
            ]
        }

    LLMAdapter(mode="live", transport=fake_transport).generate_json("rerank", RerankPlan)

    assert captured_payload["model"] == "deepseek-v4-flash"


def test_llm_adapter_post_live_reads_endpoint_and_key_from_dotenv(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text(
        "DeepSeek_BASE_URL=https://api.deepseek.example/v1\nDeepSeek_API_KEY=test_key\n",
        encoding="utf-8",
    )
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"choices":[{"message":{"content":"{}"}}]}'

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.headers["Authorization"]
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("backend.app.services.llm_adapter.request.urlopen", fake_urlopen)

    completion = LLMAdapter(mode="live")._post_live({"model": "deepseek-v4-flash"})

    assert captured == {
        "url": "https://api.deepseek.example/v1/chat/completions",
        "auth": "Bearer test_key",
        "timeout": 30,
    }
    assert completion["choices"][0]["message"]["content"] == "{}"


def test_llm_adapter_live_mode_rejects_non_json_transport_output():
    adapter = LLMAdapter(
        mode="live",
        transport=lambda _payload: {"choices": [{"message": {"content": "not json"}}]},
    )

    with pytest.raises(LLMAdapterError):
        adapter.generate_json("rerank", RerankPlan)


class OrderedAdapter:
    mode = "mock"

    def generate_json(self, _prompt, _schema):
        return RerankPlan(
            ordered_product_ids=["prod_headphones_003", "prod_headphones_002"],
            rationale="prefer premium first",
        )


def test_llm_reranker_does_not_restore_hard_constraint_violations():
    store = ProductStore(load_default_artifact=False)
    route = TaskRouter().route("Recommend wireless headphones under 100 dollars")
    intent = IntentParser().parse("Recommend wireless headphones under 100 dollars", route)
    retrieved = Retriever(store).retrieve(intent)
    verified = ConstraintVerifier().verify(retrieved, intent)
    safe = ConstraintVerifier().final_validate(verified)

    reranked, summary = LLMReranker(adapter=OrderedAdapter()).rerank(safe, intent)

    assert "prod_headphones_003" not in [product.product_id for product in reranked]
    assert summary["output_item_ids"] == ["prod_headphones_002", "prod_headphones_001"]


def test_grounded_response_generator_attaches_supported_and_unknown_claims():
    store = ProductStore(load_default_artifact=False)
    products = [store.get("prod_headphones_001"), store.get("prod_headphones_002")]
    assert products[0] is not None
    assert products[1] is not None
    intent = IntentParser().parse(
        "Recommend wireless headphones",
        TaskRouter().route("Recommend wireless headphones"),
    )

    message, enriched_products, claims = GroundedResponseGenerator().generate(
        intent,
        [products[0], products[1]],  # type: ignore[list-item]
    )

    assert "wireless headphones" in message
    assert enriched_products[0].claim_evidence
    assert any(claim.supported for claim in claims)
    assert any(not claim.supported and claim.evidence_type == "unknown" for claim in claims)


def test_chat_orchestrator_and_trace_logger_emit_claim_evidence():
    response = ChatOrchestrator().run(
        ChatRequest(message="Recommend wireless headphones under 100 dollars.")
    )
    trace = InMemoryTraceStore().write_from_response("Recommend wireless headphones", response)

    assert response.products[0].claim_evidence
    assert trace.response["claims"]
