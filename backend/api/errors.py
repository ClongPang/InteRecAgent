"""统一错误契约（BE-005、规格 §6.6）。"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ..application.errors import (
    MissionNotFound,
    MissionVersionConflict,
    ModelUnavailableError,
    UpstreamUnavailableError,
)


def _payload(
    request: Request,
    *,
    code: str,
    category: str,
    message: str,
    retryable: bool,
    degraded: bool = False,
    details: dict | None = None,
) -> dict:
    return {
        "error": {
            "code": code,
            "category": category,
            "message": message,
            "retryable": retryable,
            "degraded_result_available": degraded,
            "trace_id": getattr(request.state, "trace_id", None),
            "details": details or {},
        }
    }


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(MissionNotFound)
    async def _mission_not_found(request: Request, exc: MissionNotFound):
        return JSONResponse(
            status_code=404,
            content=_payload(request, code="mission_not_found", category="user",
                             message="任务不存在", retryable=False),
        )

    @app.exception_handler(MissionVersionConflict)
    async def _version_conflict(request: Request, exc: MissionVersionConflict):
        return JSONResponse(
            status_code=409,
            content=_payload(request, code="mission_version_conflict", category="user",
                             message="任务约束版本已变化，请刷新后重试", retryable=False),
        )

    @app.exception_handler(UpstreamUnavailableError)
    async def _upstream(request: Request, exc: UpstreamUnavailableError):
        return JSONResponse(
            status_code=503,
            content=_payload(
                request,
                code=exc.code,
                category=exc.category,
                message=exc.user_message or "上游服务不可用",
                retryable=exc.retryable,
                degraded=True,
            ),
        )

    @app.exception_handler(ModelUnavailableError)
    async def _model(request: Request, exc: ModelUnavailableError):
        return JSONResponse(
            status_code=503,
            content=_payload(request, code="model_unavailable", category="model",
                             message=str(exc), retryable=False),
        )

    @app.exception_handler(Exception)
    async def _internal(request: Request, exc: Exception):
        # 不暴露堆栈或密钥；trace_id 关联日志
        return JSONResponse(
            status_code=500,
            content=_payload(request, code="internal_error", category="system",
                             message="服务器内部错误", retryable=False),
        )
