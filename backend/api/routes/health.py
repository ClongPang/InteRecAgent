"""Process liveness and dependency readiness endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text

from ..dependencies import get_session_factory

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
async def live() -> dict:
    """Report whether the API process is alive."""
    return {"status": "ok"}


@router.get("/ready")
async def ready(session_factory=Depends(get_session_factory)) -> JSONResponse:
    """Report whether the database and application composition are ready."""
    try:
        async with session_factory() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return JSONResponse({"status": "ok"})
