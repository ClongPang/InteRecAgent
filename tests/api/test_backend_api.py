from fastapi.testclient import TestClient

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
    assert trace_response.json()["task_route"]["task_type"] == "single_item_recommendation"

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
    assert missing.json()["detail"]["code"] == "product_not_found"


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
