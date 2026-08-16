from __future__ import annotations

from ..application.errors import UpstreamUnavailableError


def is_retryable(exc: BaseException) -> bool:
    """401/校验错误不重试；429/5xx/网络错误可重试（BE-003）。"""
    return isinstance(exc, UpstreamUnavailableError) and exc.retryable


def retry_wait(retry_state) -> float:
    """429 时遵守 Retry-After（封顶 8s）；其余固定 0.5s。"""
    exc = retry_state.outcome.exception()
    if isinstance(exc, UpstreamUnavailableError) and exc.retry_after is not None:
        return min(exc.retry_after, 8.0)
    return 0.5
