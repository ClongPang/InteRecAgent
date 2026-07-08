from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.schemas import (
    ChatRequest,
    ChatTurnResponse,
    ErrorResponse,
    HealthResponse,
    ProductRecommendation,
    ReplayResult,
    SessionState,
)
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.evaluation_service import EvaluationService
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


@app.post("/api/internal/replay", response_model=ReplayResult)
def replay_turn(turn_id: str = "turn_001") -> ReplayResult:
    return replay_runner.replay(trace_store.read(turn_id), turn_id)
