"""FastAPI 依赖注入。"""
from __future__ import annotations

import uuid

from fastapi import Header, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..application.errors import InvalidAnonymousUser


def get_session_factory(request: Request) -> async_sessionmaker[AsyncSession]:
    return request.app.state.session_factory


def get_command_service(request: Request):
    return request.app.state.command_service


def get_anonymous_user_id(x_anonymous_user_id: str = Header(...)) -> str:
    """开发态匿名用户标识。跨 owner 隔离用。"""
    try:
        return str(uuid.UUID(x_anonymous_user_id))
    except ValueError:
        raise InvalidAnonymousUser()
