from fastapi.testclient import TestClient

from backend.app import main
from backend.app.main import app
from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.product_store import ProductStore
from backend.app.services.profile_store import ProfileStore


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
    assert body["products"][1]["constraint_status"] == "unknown_critical"
    assert body["products"][1]["uncertainties"] == ["price unknown", "review evidence missing"]

    trace_response = client.get(f"/api/internal/traces/{body['turn_id']}")
    assert trace_response.status_code == 200
    trace = trace_response.json()
    assert trace["task_route"]["task_type"] == "single_item_recommendation"
    assert trace["filtering"]["input_count"] == body["trace_summary"]["retrieved_count"]
    assert trace["filtering"]["output_count"] == body["trace_summary"]["filtered_count"]
    assert trace["filtering"]["unknown_constraints"][0]["product_id"] == "prod_headphones_002"
    assert trace["filtering"]["unknown_constraints"][0]["checks"][0]["status"] == "unknown_critical"

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


def test_api_can_use_catalog_artifact_for_product_lookup_and_chat(monkeypatch, tmp_path):
    catalog_path = tmp_path / "normalized_catalog.jsonl"
    catalog_path.write_text(
        "\n".join(
            [
                '{"product_id":"artifact_mouse_001","title":"Artifact Quiet Office Mouse","brand":"DeskLab","price":29.99,"category_path":["Electronics","Mouse"],"leaf_category":"Wireless Mouse","matched_tags":["quiet","office"],"evidence":[{"source":"review","product_id":"artifact_mouse_001","text":"Reviewers mention quiet office use."}],"rank":0}',
                '{"product_id":"artifact_headphones_001","title":"Artifact Wireless Headphones","brand":"SoundLab","price":79.99,"category_path":["Electronics","Headphones"],"leaf_category":"Wireless Headphones","matched_tags":["wireless"],"evidence":[{"source":"review","product_id":"artifact_headphones_001","text":"Reviewers mention wireless commute use."}],"rank":0}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    artifact_store = ProductStore(catalog_path=catalog_path)
    monkeypatch.setattr(main, "product_store", artifact_store)
    monkeypatch.setattr(main, "chat_orchestrator", ChatOrchestrator(product_store=artifact_store))

    local_client = TestClient(app)
    found = local_client.get("/api/products/artifact_mouse_001")
    chat_response = local_client.post(
        "/api/chat",
        json=ChatRequest(
            session_id="sess_artifact_catalog",
            message="Recommend a quiet office mouse",
        ).model_dump(),
    )

    assert found.status_code == 200
    assert found.json()["title"] == "Artifact Quiet Office Mouse"
    assert chat_response.status_code == 200
    assert chat_response.json()["products"][0]["product_id"] == "artifact_mouse_001"


def test_api_uses_user_profile_when_user_id_is_provided(monkeypatch):
    artifact_store = ProductStore(load_default_artifact=False)
    profile_store = ProfileStore(
        profiles={
            "U_PROFILE": {
                "user_id": "U_PROFILE",
                "preferred_categories": [{"category": "Wireless Headphones", "count": 2}],
                "positive_product_ids": ["prod_headphones_002"],
                "negative_product_ids": [],
            }
        }
    )
    monkeypatch.setattr(main, "product_store", artifact_store)
    monkeypatch.setattr(
        main,
        "chat_orchestrator",
        ChatOrchestrator(product_store=artifact_store, profile_store=profile_store),
    )

    local_client = TestClient(app)
    response = local_client.post(
        "/api/chat",
        json={
            "user_id": "U_PROFILE",
            "message": "Recommend compact portable wireless headphones",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_state"]["long_term_profile"]["user_id"] == "U_PROFILE"
    assert body["trace_summary"]["ranking_summary"]["profile_applied"] is True


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
    body = response.json()
    metrics = body["metrics"]
    assert set(metrics) == {
        "task_type_accuracy",
        "intent_slot_f1",
        "constraint_satisfaction",
        "evidence_coverage",
        "feedback_recovery",
    }
    assert body["readiness"]["gates"]["task_type_accuracy"]["threshold"] == 0.95
    assert "unsupported_claim_rate" in body["readiness"]["gates"]
    assert "unknown_critical_constraint_rate" in body["readiness"]["gates"]
    assert body["case_results"][0]["case_id"] == "task_headphones_simple_001"
    assert body["case_results"][0]["actual_status"] in {
        "recommendations_ready",
        "clarification_required",
        "unsupported",
    }


def test_evaluation_run_lookup_returns_requested_run_id():
    response = client.get("/api/evaluation/runs/eval_lookup")

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "eval_lookup"
    assert body["metrics"]["task_type_accuracy"] > 0


def test_catalog_readiness_endpoint_reports_current_artifact_status():
    response = client.get("/api/internal/catalog/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert body["scale_status"] == "missing"
    assert body["product_count"] == 0
    assert any("normalized catalog is missing" in error for error in body["errors"])


def test_evaluation_dataset_readiness_endpoint_reports_current_case_status():
    response = client.get("/api/internal/evaluation/dataset/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is True
    assert body["path"] == "data/eval/task_cases.jsonl"
    assert body["case_count"] == 140
    assert "single_item_recommendation" in body["labels"]
    assert "unsupported" in body["labels"]
    assert body["errors"] == []


def test_profile_readiness_endpoint_reports_current_artifact_status():
    response = client.get("/api/internal/profiles/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert body["profile_count"] == 0
    assert body["profiles_path"] == "data/profiles/user_profiles.jsonl"
    assert any("user profiles are missing" in error for error in body["errors"])


def test_vector_index_readiness_endpoint_reports_current_artifact_status():
    response = client.get("/api/internal/index/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert body["product_count"] == 0
    assert body["index_path"] == "data/indexes/product_index.jsonl"
    assert any("vector index is missing" in error for error in body["errors"])


def test_system_readiness_endpoint_aggregates_artifact_gates():
    response = client.get("/api/internal/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert set(body["gates"]) == {"catalog", "evaluation_cases", "profiles", "vector_index"}
    assert body["gates"]["catalog"]["ready"] is False
    assert any(error.startswith("catalog:") for error in body["errors"])
    assert any(error.startswith("vector_index:") for error in body["errors"])


def test_readiness_endpoints_follow_runtime_artifact_environment(monkeypatch, tmp_path):
    catalog_dir = tmp_path / "catalog_alt"
    eval_cases_path = tmp_path / "eval_alt" / "custom_task_cases.jsonl"
    profile_dir = tmp_path / "profiles_alt"
    index_dir = tmp_path / "indexes_alt"
    eval_cases_path.parent.mkdir(parents=True)
    eval_cases_path.write_text("", encoding="utf-8")
    monkeypatch.setenv("INTEREC_CATALOG_PATH", str(catalog_dir / "normalized_catalog.jsonl"))
    monkeypatch.setenv("INTEREC_EVAL_CASES_PATH", str(eval_cases_path))
    monkeypatch.setenv("INTEREC_PROFILE_PATH", str(profile_dir / "user_profiles.jsonl"))
    monkeypatch.setenv("INTEREC_INDEX_PATH", str(index_dir / "product_index.jsonl"))
    monkeypatch.setenv("INTEREC_TARGET_MIN", "7")
    monkeypatch.setenv("INTEREC_TARGET_MAX", "9")
    monkeypatch.setenv("INTEREC_DEMO_LIMIT", "3")
    monkeypatch.setenv("INTEREC_EVAL_MIN_CASES", "11")
    monkeypatch.setenv("INTEREC_EVAL_MAX_CASES", "12")
    monkeypatch.setenv("INTEREC_PROFILE_MIN_PROFILES", "13")
    monkeypatch.setenv("INTEREC_INDEX_MIN_PRODUCTS", "14")

    catalog = client.get("/api/internal/catalog/readiness").json()
    eval_cases = client.get("/api/internal/evaluation/dataset/readiness").json()
    profile = client.get("/api/internal/profiles/readiness").json()
    index = client.get("/api/internal/index/readiness").json()
    system = client.get("/api/internal/readiness").json()

    assert catalog["catalog_path"] == str(catalog_dir / "normalized_catalog.jsonl")
    assert eval_cases["path"] == str(eval_cases_path)
    assert profile["profiles_path"] == str(profile_dir / "user_profiles.jsonl")
    assert index["index_path"] == str(index_dir / "product_index.jsonl")
    assert any("target minimum is 7" in error for error in catalog["errors"])
    assert any("below minimum 11" in error for error in eval_cases["errors"])
    assert any("minimum is 13" in error for error in profile["errors"])
    assert any("minimum is 14" in error for error in index["errors"])
    assert any(str(catalog_dir) in error for error in system["gates"]["catalog"]["errors"])
    assert any(
        "below minimum 11" in error
        for error in system["gates"]["evaluation_cases"]["errors"]
    )
    assert any(str(profile_dir) in error for error in system["gates"]["profiles"]["errors"])
    assert any(str(index_dir) in error for error in system["gates"]["vector_index"]["errors"])
