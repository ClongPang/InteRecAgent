from __future__ import annotations

from typing import Any

from app.observability.alerts import rt_monitor, send_alert


async def record_breaker_result(context: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = context.get("tool_name")
    duration_ms = context.get("duration_ms")
    if not isinstance(tool_name, str) or duration_ms is None:
        return None

    try:
        rt_monitor.record(tool_name, int(duration_ms))
    except (TypeError, ValueError):
        return None

    for alert in rt_monitor.check_alerts():
        await send_alert(alert)
    return None
