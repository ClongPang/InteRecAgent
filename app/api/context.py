# app/api/context.py

from contextvars import ContextVar
from pathlib import Path
from typing import Literal, Optional


UserTier = Literal["free", "standard", "premium"]

# 当前请求的 thread_id (由 /api/task 入口设置)
_thread_id_var: ContextVar[Optional[str]] = ContextVar(
    "heartShop_thread_id", default=None
)

# 当前请求的会话目录 (输出文件落到这里)
_session_dir_var: ContextVar[Optional[Path]] = ContextVar(
    "heartShop_session_dir", default=None
)

_user_tier_var: ContextVar[Optional[UserTier]] = ContextVar(
    "heartShop_user_tier", default=None
)

def set_thread_context(
    thread_id: str,
    session_dir: Path,
    user_tier: UserTier | None = None,
) -> None:
    """请求入口处调用，写入本次任务的身份信息。"""
    _thread_id_var.set(thread_id)
    _session_dir_var.set(session_dir)
    _user_tier_var.set(user_tier)


def get_thread_id() -> Optional[str]:
    return _thread_id_var.get()


def get_thread_context() -> Optional[str]:
    """Compatibility alias used by the AGUI monitor examples."""
    return get_thread_id()


def get_session_dir() -> Optional[Path]:
    return _session_dir_var.get()


def get_user_tier(default: UserTier = "free") -> UserTier:
    return _user_tier_var.get() or default
