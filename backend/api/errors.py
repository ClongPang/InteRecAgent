"""统一错误契约（BE-005、规格 §6.6）。"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..application.errors import (
    ApplicationError,
    DispatcherNotAccepting,
    InvalidAnonymousUser,
    InvalidComparison,
    MissionNotFound,
    MissionVersionConflict,
    ModelUnavailableError,
    NothingToUndo,
    RecommendationNotFound,
    RunNotRunning,
    SnapshotNotFound,
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
            content=_payload(
                request,
                code="mission_not_found",
                category="user",
                message="任务不存在",
                retryable=False,
            ),
        )

    @app.exception_handler(RecommendationNotFound)
    async def _recommendation_not_found(request: Request, exc: RecommendationNotFound):
        return JSONResponse(
            status_code=404,
            content=_payload(
                request,
                code="recommendation_not_found",
                category="user",
                message="尚无推荐结果",
                retryable=False,
            ),
        )

    @app.exception_handler(MissionVersionConflict)
    async def _version_conflict(request: Request, exc: MissionVersionConflict):
        return JSONResponse(
            status_code=409,
            content=_payload(
                request,
                code="mission_version_conflict",
                category="user",
                message="任务约束版本已变化，请刷新后重试",
                retryable=False,
            ),
        )

    @app.exception_handler(RunNotRunning)
    async def _run_not_running(request: Request, exc: RunNotRunning):
        return JSONResponse(
            status_code=409,
            content=_payload(
                request,
                code="run_not_running",
                category="user",
                message="当前没有可停止的运行",
                retryable=False,
            ),
        )

    @app.exception_handler(NothingToUndo)
    async def _nothing_to_undo(request: Request, exc: NothingToUndo):
        return JSONResponse(
            status_code=409,
            content=_payload(
                request,
                code="nothing_to_undo",
                category="user",
                message="没有可撤销的条件变更",
                retryable=False,
            ),
        )

    @app.exception_handler(InvalidComparison)
    async def _invalid_comparison(request: Request, exc: InvalidComparison):
        return JSONResponse(
            status_code=400,
            content=_payload(
                request,
                code="invalid_comparison",
                category="user",
                message=str(exc) or "比较集合不合法",
                retryable=False,
            ),
        )

    @app.exception_handler(InvalidAnonymousUser)
    async def _invalid_user(request: Request, exc: InvalidAnonymousUser):
        return JSONResponse(
            status_code=400,
            content=_payload(
                request,
                code="invalid_anonymous_user",
                category="user",
                message="X-Anonymous-User-ID 必须是 UUID",
                retryable=False,
            ),
        )

    @app.exception_handler(DispatcherNotAccepting)
    async def _dispatcher_stopped(request: Request, exc: DispatcherNotAccepting):
        return JSONResponse(
            status_code=503,
            content=_payload(
                request,
                code="dispatcher_not_accepting",
                category="system",
                message="服务正在关闭，请稍后重试",
                retryable=True,
            ),
        )

    @app.exception_handler(SnapshotNotFound)
    async def _snapshot_not_found(request: Request, exc: SnapshotNotFound):
        return JSONResponse(
            status_code=404,
            content=_payload(
                request,
                code="snapshot_not_found",
                category="user",
                message="商品快照不存在",
                retryable=False,
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        details = []
        for err in exc.errors():
            details.append(
                {
                    "loc": [str(part) for part in err.get("loc", ())],
                    "msg": err.get("msg"),
                    "type": err.get("type"),
                }
            )
        return JSONResponse(
            status_code=422,
            content=_payload(
                request,
                code="validation_error",
                category="user",
                message="请求参数不合法",
                retryable=False,
                details={"errors": details},
            ),
        )

    @app.exception_handler(ApplicationError)
    async def _application(request: Request, exc: ApplicationError):
        return JSONResponse(
            status_code=400,
            content=_payload(
                request,
                code="application_error",
                category="user",
                message=str(exc) or "请求无法处理",
                retryable=False,
            ),
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
            content=_payload(
                request,
                code="model_unavailable",
                category="model",
                message=str(exc),
                retryable=False,
            ),
        )

    @app.exception_handler(Exception)
    async def _internal(request: Request, exc: Exception):
        return JSONResponse(
            status_code=500,
            content=_payload(
                request,
                code="internal_error",
                category="system",
                message="服务器内部错误",
                retryable=False,
            ),
        )
