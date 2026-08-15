# app/utils/thread_ctx.py
from contextlib import contextmanager
from pathlib import Path
from app.api.context import (
    _thread_id_var, _session_dir_var, _user_tier_var,
    get_session_dir,
    get_thread_context,
    get_thread_id,
    set_thread_context,
    UserTier,
)


@contextmanager
def thread_scope(
    thread_id: str,
    session_dir: Path,
    user_tier: UserTier | None = None,
):
    """作用域内绑定 thread_id 与 session_dir，离开作用域自动还原。"""
    token_t = _thread_id_var.set(thread_id)
    token_s = _session_dir_var.set(session_dir)
    token_u = _user_tier_var.set(user_tier)
    try:
        yield
    finally:
        _thread_id_var.reset(token_t)
        _session_dir_var.reset(token_s)
        _user_tier_var.reset(token_u)
