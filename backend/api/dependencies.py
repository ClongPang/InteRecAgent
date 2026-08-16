"""FastAPI 依赖注入。"""
from __future__ import annotations

import uuid

from fastapi import Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


def get_session_factory(request: Request) -> async_sessionmaker[AsyncSession]:
    return request.app.state.session_factory


def get_command_service(request: Request):
    return request.app.state.command_service


def get_anonymous_user_id(x_anonymous_user_id: str = Header(...)) -> str:
    """开发态匿名用户标识。不是认证凭据（ASM-001）；跨 owner 隔离用。"""
    try:
        return str(uuid.UUID(x_anonymous_user_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="X-Anonymous-User-ID 必须是 UUID")
