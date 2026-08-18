"""健康检查"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text

from ..dependencies import get_session_factory

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
async def live() -> dict:
    """进程存活"""
    return {"status": "ok"}


@router.get("/ready")
async def ready(session_factory=Depends(get_session_factory)) -> dict:
    """就绪：DB 与组合根可用"""
    try:
        async with session_factory() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return {"status": "ok"}
