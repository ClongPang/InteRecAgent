from __future__ import annotations

import logging
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any, Literal


logger = logging.getLogger(__name__)

HookPoint = Literal[
    "on_session_start",
    "pre_think",
    "pre_tool_call",
    "post_tool_call",
    "post_reflect",
    "on_session_end",
]

HOOK_POINTS: tuple[HookPoint, ...] = (
    "on_session_start",
    "pre_think",
    "pre_tool_call",
    "post_tool_call",
    "post_reflect",
    "on_session_end",
)

HookFn = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]


class HookRejectSignal(Exception):
    """Raised by a hook to reject the current operation without crashing AgentLoop."""


class HarnessMiddleware:
    """Agent Harness unified Hook Pipeline."""

    def __init__(self) -> None:
        self._hooks: dict[str, list[tuple[int, str, HookFn]]] = defaultdict(list)

    def register(
        self,
        hook_point: str,
        name: str,
        fn: HookFn,
        priority: int = 100,
    ) -> None:
        if hook_point not in HOOK_POINTS:
            raise ValueError(f"Unknown hook point: {hook_point}")

        hooks = [
            hook
            for hook in self._hooks[hook_point]
            if hook[1] != name
        ]
        hooks.append((priority, name, fn))
        hooks.sort(key=lambda item: item[0])
        self._hooks[hook_point] = hooks

    def list_hooks(self, hook_point: str | None = None) -> dict[str, list[str]]:
        points = [hook_point] if hook_point else list(HOOK_POINTS)
        return {
            point: [name for _, name, _ in self._hooks.get(point, [])]
            for point in points
        }

    def clear(self) -> None:
        self._hooks.clear()

    async def run(self, hook_point: str, context: dict[str, Any]) -> dict[str, Any]:
        if hook_point not in HOOK_POINTS:
            raise ValueError(f"Unknown hook point: {hook_point}")

        current = dict(context)
        for priority, name, fn in self._hooks.get(hook_point, []):
            t0 = time.time()
            try:
                result = await fn(current)
                if result:
                    current.update(result)
            except HookRejectSignal as exc:
                current.update({
                    "_rejected": True,
                    "_reject_hook": name,
                    "_reject_reason": str(exc),
                })
                logger.info("Hook [%s] rejected %s: %s", name, hook_point, exc)
                break
            except Exception:
                logger.exception("Hook [%s] failed at %s", name, hook_point)
            finally:
                duration_ms = int((time.time() - t0) * 1000)
                if duration_ms > 50:
                    logger.info(
                        "Hook [%s] at %s took %sms",
                        name,
                        hook_point,
                        duration_ms,
                    )
        return current


harness = HarnessMiddleware()


def harness_hook(hook_point: str, name: str, priority: int = 100):
    """Decorator-based hook registration."""

    def decorator(fn: HookFn) -> HookFn:
        harness.register(hook_point, name, fn, priority)
        return fn

    return decorator
