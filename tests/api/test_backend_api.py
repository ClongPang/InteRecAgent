from fastapi.testclient import TestClient

from backend.app import main
from backend.app.main import app


client = TestClient(app)


def test_health_endpoint_returns_service_status():
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_chat_returns_recommendations_and_writes_trace():
    response = client.post(
        "/api/chat",
        json={
            "session_id": "sess_api_recommend",
            "message": "Recommend wireless headphones under 100 dollars for commuting.",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "recommendations_ready"
    assert body["products"][0]["constraint_status"] == "satisfied"
    assert body["products"][1]["uncertainties"] == ["price unknown", "review evidence missing"]

    trace_response = client.get(f"/api/internal/traces/{body['turn_id']}")
    assert trace_response.status_code == 200
    trace = trace_response.json()
    assert trace["task_route"]["task_type"] == "single_item_recommendation"
    assert trace["filtering"]["input_count"] == body["trace_summary"]["retrieved_count"]
    assert trace["filtering"]["output_count"] == body["trace_summary"]["filtered_count"]
    assert trace["filtering"]["unknown_constraints"][0]["product_id"] == "prod_headphones_002"

    replay_response = client.post(f"/api/internal/replay?turn_id={body['turn_id']}")
    assert replay_response.status_code == 200
    assert "filter" in replay_response.json()["stages"]

    session_response = client.get("/api/sessions/sess_api_recommend")
    assert session_response.status_code == 200
    session = session_response.json()
    assert session["current_intent"]["category"] == "wireless headphones"
    assert session["messages"][0]["role"] == "user"


def test_chat_returns_clarification_for_ambiguous_work_request():
    response = client.post("/api/chat", json={"message": "I need something for work"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "clarification_required"
    assert body["clarification"]["allow_recommend_anyway"] is True


def test_chat_stops_clarifying_after_three_turns_for_same_session():
    session_id = "sess_api_clarification_limit"
    responses = [
        client.post(
            "/api/chat",
            json={"session_id": session_id, "message": "I need something for work"},
        ).json()
        for _ in range(4)
    ]

    assert [response["status"] for response in responses[:3]] == [
        "clarification_required",
        "clarification_required",
        "clarification_required",
    ]
    assert responses[3]["status"] == "recommendations_ready"
    assert responses[3]["trace_summary"]["clarification_decision"]["reason"] == (
        "clarification limit reached; recommending from available catalog evidence"
    )


def test_chat_returns_unsupported_for_live_commerce_request():
    response = client.post(
        "/api/chat",
        json={"message": "Can you check live stock and buy it for me?"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unsupported"
    assert "Checkout" in body["unsupported"]["cannot_do"]


def test_feedback_request_carries_anchor_context():
    response = client.post(
        "/api/chat",
        json={
            "session_id": "sess_demo",
            "turn_id": "turn_feedback",
            "message": "Show me something similar but cheaper",
            "feedback_text": "Too expensive",
            "feedback_type": "price",
            "anchor_product_id": "prod_headphones_001",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["task_type"] == "negative_feedback"
    assert body["trace_summary"]["feedback_update"]["feedback_type"] == "price"


def test_product_lookup_and_not_found_error_shape():
    found = client.get("/api/products/prod_headphones_001")
    assert found.status_code == 200
    assert found.json()["product_id"] == "prod_headphones_001"

    missing = client.get("/api/products/missing")
    assert missing.status_code == 404
    assert missing.json() == {
        "code": "product_not_found",
        "message": "Product was not found in the demo catalog.",
        "details": {"product_id": "missing"},
    }


def test_validation_error_uses_stable_error_shape():
    response = client.post("/api/chat", json={"session_id": "sess_missing_message"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "request_validation_error"
    assert body["message"] == "Request failed validation."
    assert body["details"]["errors"][0]["loc"] == ["body", "message"]


def test_chat_pipeline_error_writes_internal_trace(monkeypatch):
    def fail_run(*_args, **_kwargs):
        raise RuntimeError("sensitive provider failure")

    monkeypatch.setattr(main.chat_orchestrator, "run", fail_run)
    local_client = TestClient(app, raise_server_exceptions=False)

    response = local_client.post(
        "/api/chat",
        json={
            "session_id": "sess_api_error_trace",
            "turn_id": "turn_api_error_trace",
            "message": "Recommend wireless headphones.",
        },
    )

    assert response.status_code == 500
    body = response.json()
    assert body == {
        "code": "chat_pipeline_error",
        "message": "Chat pipeline failed before a safe response could be generated.",
        "details": {
            "turn_id": "turn_api_error_trace",
            "session_id": "sess_api_error_trace",
        },
    }

    trace_response = local_client.get("/api/internal/traces/turn_api_error_trace")
    assert trace_response.status_code == 200
    trace = trace_response.json()
    assert trace["errors"] == [
        {
            "code": "chat_pipeline_error",
            "message": "Chat pipeline failed before a safe response could be generated.",
            "stage": "chat_orchestrator",
        }
    ]
    assert trace["response"]["status"] == "error"
    assert "sensitive provider failure" not in trace_response.text


def test_evaluation_runner_returns_five_metrics():
    response = client.post("/api/evaluation/run")

    assert response.status_code == 200
    metrics = response.json()["metrics"]
    assert set(metrics) == {
        "task_type_accuracy",
        "intent_slot_f1",
        "constraint_satisfaction",
        "evidence_coverage",
        "feedback_recovery",
    }


def test_evaluation_run_lookup_returns_requested_run_id():
    response = client.get("/api/evaluation/runs/eval_lookup")

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "eval_lookup"
    assert body["metrics"]["task_type_accuracy"] > 0
