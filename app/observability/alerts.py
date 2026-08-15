# app/observability/alerts.py
import os
from collections import deque
from dataclasses import dataclass

import numpy as np


@dataclass
class AlertRule:
    tool_name: str
    p99_threshold_ms: int
    window_minutes: int = 5
    min_samples: int = 10


ALERT_RULES = [
    AlertRule("item_search", p99_threshold_ms=3000),
    AlertRule("price_compare", p99_threshold_ms=500),
    AlertRule("shipping_calc", p99_threshold_ms=200),
    AlertRule("category_insight", p99_threshold_ms=2000),
    AlertRule("shopping_summary", p99_threshold_ms=4000),
    AlertRule("dispatch_tool", p99_threshold_ms=5000),
]


class ToolRTMonitor:
    def __init__(self) -> None:
        self._windows: dict[str, deque[int]] = {}
        for rule in ALERT_RULES:
            self._windows[rule.tool_name] = deque(maxlen=200)

    def record(self, tool_name: str, duration_ms: int) -> None:
        if tool_name in self._windows:
            self._windows[tool_name].append(duration_ms)

    def check_alerts(self) -> list[str]:
        alerts: list[str] = []

        for rule in ALERT_RULES:
            window = self._windows[rule.tool_name]
            if len(window) < rule.min_samples:
                continue
            p99 = float(np.percentile(list(window), 99))
            if p99 > rule.p99_threshold_ms:
                alerts.append(
                    f"[ALERT] {rule.tool_name} P99={p99:.0f}ms > {rule.p99_threshold_ms}ms"
                )
        return alerts


rt_monitor = ToolRTMonitor()


async def send_alert(message: str) -> None:
    import httpx

    webhook_url = os.environ.get("ALERT_WEBHOOK_URL")
    if not webhook_url:
        return
    async with httpx.AsyncClient() as client:
        await client.post(webhook_url, json={
            "msgtype": "text",
            "text": {"content": f"[Globex Agent] {message}"},
        })
