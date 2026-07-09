from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.schemas import (
    CatalogReadinessResponse,
    ChatRequest,
    ChatTurnResponse,
    ErrorResponse,
    EvaluationDatasetReadinessResponse,
    HealthResponse,
    ProductRecommendation,
    ProfileReadinessResponse,
    ReplayResult,
    SessionState,
    SystemReadinessResponse,
    VectorIndexReadinessResponse,
)
from backend.app.data_pipeline.catalog_builder import CatalogBuildConfig
from backend.app.data_pipeline.catalog_readiness import check_catalog_readiness
from backend.app.data_pipeline.profile_readiness import check_profile_readiness
from backend.app.data_pipeline.vector_index_readiness import check_vector_index_readiness
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.evaluation_service import EvaluationService
from backend.app.services.evaluation_dataset_readiness import check_task_case_readiness
from backend.app.services.product_store import ProductStore
from backend.app.services.replay_runner import ReplayRunner
from backend.app.services.session_state import SessionStateManager
from backend.app.services.trace_logger import trace_store


app = FastAPI(title="InteRecAgent API", version="0.1.0")
product_store = ProductStore()
chat_orchestrator = ChatOrchestrator(product_store=product_store)
evaluation_service = EvaluationService()
session_state = SessionStateManager()
replay_runner = ReplayRunner()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _artifact_dir_from_env(env_name: str, default_dir: str) -> Path:
    configured_path = os.getenv(env_name)
    return Path(configured_path).parent if configured_path else Path(default_dir)


def _catalog_artifact_dir() -> Path:
    return _artifact_dir_from_env("INTEREC_CATALOG_PATH", "data/catalog")


def _profile_artifact_dir() -> Path:
    return _artifact_dir_from_env("INTEREC_PROFILE_PATH", "data/profiles")


def _index_artifact_dir() -> Path:
    return _artifact_dir_from_env("INTEREC_INDEX_PATH", "data/indexes")


def _eval_cases_path() -> Path:
    configured_path = os.getenv("INTEREC_EVAL_CASES_PATH")
    return Path(configured_path) if configured_path else Path("data/eval/task_cases.jsonl")


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _catalog_readiness_config() -> CatalogBuildConfig:
    return CatalogBuildConfig(
        target_min_products=_env_int("INTEREC_TARGET_MIN", 20_000),
        target_max_products=_env_int("INTEREC_TARGET_MAX", 50_000),
        demo_pool_limit=_env_int("INTEREC_DEMO_LIMIT", 50),
    )


@app.exception_handler(HTTPException)
def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and {"code", "message", "details"}.issubset(exc.detail):
        error = ErrorResponse.model_validate(exc.detail)
    else:
        error = ErrorResponse(
            code="http_error",
            message=str(exc.detail),
            details={"status_code": exc.status_code},
        )
    return JSONResponse(status_code=exc.status_code, content=error.model_dump())


@app.exception_handler(RequestValidationError)
def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    error = ErrorResponse(
        code="request_validation_error",
        message="Request failed validation.",
        details={"errors": exc.errors()},
    )
    return JSONResponse(status_code=422, content=error.model_dump())


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@app.post("/api/chat", response_model=ChatTurnResponse)
def chat(request: ChatRequest) -> ChatTurnResponse:
    session_id = request.session_id or "sess_demo"
    allow_clarification = len(session_state.clarification_turns(session_id)) < 3
    turn_id = request.turn_id or "turn_001"
    try:
        response = chat_orchestrator.run(request, allow_clarification=allow_clarification)
    except Exception:
        trace_store.write_error(
            turn_id=turn_id,
            session_id=session_id,
            request_message=request.message,
            error={
                "code": "chat_pipeline_error",
                "message": "Chat pipeline failed before a safe response could be generated.",
                "stage": "chat_orchestrator",
            },
        )
        raise HTTPException(
            status_code=500,
            detail={
                "code": "chat_pipeline_error",
                "message": "Chat pipeline failed before a safe response could be generated.",
                "details": {"turn_id": turn_id, "session_id": session_id},
            },
        )
    trace_store.write_from_response(request.message, response)
    session_state.record_turn(request, response)
    return response


@app.get("/api/sessions/{session_id}", response_model=SessionState)
def get_session(session_id: str) -> SessionState:
    return session_state.get(session_id)


@app.get("/api/products/{product_id}", response_model=ProductRecommendation)
def get_product(product_id: str) -> ProductRecommendation:
    product = product_store.get(product_id)
    if product is not None:
        return product
    raise HTTPException(
        status_code=404,
        detail={
            "code": "product_not_found",
            "message": "Product was not found in the demo catalog.",
            "details": {"product_id": product_id},
        },
    )


@app.get("/api/internal/traces/{turn_id}")
def get_internal_trace(turn_id: str):
    trace = trace_store.read(turn_id)
    if trace is None:
        # Seed a deterministic trace so internal pages can develop from a known fixture.
        response = chat_orchestrator.run(
            ChatRequest(
                message="Recommend wireless headphones under 100 dollars for commuting.",
                turn_id=turn_id,
            )
        )
        trace = trace_store.write_from_response(response.message, response)
    return trace


@app.post("/api/evaluation/run")
def run_evaluation():
    return evaluation_service.run()


@app.get("/api/evaluation/runs/{run_id}")
def get_evaluation_run(run_id: str):
    return evaluation_service.run(run_id=run_id)


@app.get("/api/internal/catalog/readiness", response_model=CatalogReadinessResponse)
def get_catalog_readiness() -> CatalogReadinessResponse:
    return CatalogReadinessResponse.model_validate(
        check_catalog_readiness(_catalog_artifact_dir(), _catalog_readiness_config()).to_dict()
    )


@app.get(
    "/api/internal/evaluation/dataset/readiness",
    response_model=EvaluationDatasetReadinessResponse,
)
def get_evaluation_dataset_readiness() -> EvaluationDatasetReadinessResponse:
    return EvaluationDatasetReadinessResponse.model_validate(
        check_task_case_readiness(
            _eval_cases_path(),
            min_cases=_env_int("INTEREC_EVAL_MIN_CASES", 100),
            max_cases=_env_int("INTEREC_EVAL_MAX_CASES", 300),
        ).to_dict()
    )


@app.get("/api/internal/profiles/readiness", response_model=ProfileReadinessResponse)
def get_profile_readiness() -> ProfileReadinessResponse:
    return ProfileReadinessResponse.model_validate(
        check_profile_readiness(
            _profile_artifact_dir(),
            min_profiles=_env_int("INTEREC_PROFILE_MIN_PROFILES", 1),
        ).to_dict()
    )


@app.get("/api/internal/index/readiness", response_model=VectorIndexReadinessResponse)
def get_vector_index_readiness() -> VectorIndexReadinessResponse:
    return VectorIndexReadinessResponse.model_validate(
        check_vector_index_readiness(
            _index_artifact_dir(),
            min_products=_env_int("INTEREC_INDEX_MIN_PRODUCTS", 1),
        ).to_dict()
    )


@app.get("/api/internal/readiness", response_model=SystemReadinessResponse)
def get_system_readiness() -> SystemReadinessResponse:
    reports = {
        "catalog": check_catalog_readiness(
            _catalog_artifact_dir(),
            _catalog_readiness_config(),
        ).to_dict(),
        "evaluation_cases": check_task_case_readiness(
            _eval_cases_path(),
            min_cases=_env_int("INTEREC_EVAL_MIN_CASES", 100),
            max_cases=_env_int("INTEREC_EVAL_MAX_CASES", 300),
        ).to_dict(),
        "profiles": check_profile_readiness(
            _profile_artifact_dir(),
            min_profiles=_env_int("INTEREC_PROFILE_MIN_PROFILES", 1),
        ).to_dict(),
        "vector_index": check_vector_index_readiness(
            _index_artifact_dir(),
            min_products=_env_int("INTEREC_INDEX_MIN_PRODUCTS", 1),
        ).to_dict(),
    }
    gates = {
        name: {
            "ready": bool(report["ready"]),
            "errors": report.get("errors", []),
            "warnings": report.get("warnings", []),
        }
        for name, report in reports.items()
    }
    errors = [
        f"{name}: {error}"
        for name, report in reports.items()
        for error in report.get("errors", [])
    ]
    warnings = [
        f"{name}: {warning}"
        for name, report in reports.items()
        for warning in report.get("warnings", [])
    ]
    return SystemReadinessResponse(
        ready=all(gate["ready"] for gate in gates.values()),
        gates=gates,
        errors=errors,
        warnings=warnings,
    )


@app.post("/api/internal/replay", response_model=ReplayResult)
def replay_turn(turn_id: str = "turn_001") -> ReplayResult:
    return replay_runner.replay(trace_store.read(turn_id), turn_id)
