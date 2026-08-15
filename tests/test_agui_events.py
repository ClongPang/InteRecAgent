from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

import app.api.monitor as monitor_module
from app.api.connection import ConnectionManager
from app.api.monitor import Monitor
from app.utils.thread_ctx import thread_scope


class FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent: list[dict[str, Any]] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeManager:
    def __init__(self) -> None:
        self.sent: list[tuple[dict[str, Any], str]] = []

    async def send_to_thread(self, payload: dict[str, Any], thread_id: str) -> None:
        self.sent.append((payload, thread_id))


class AguiEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_manager_keeps_new_connection_on_stale_disconnect(self) -> None:
        manager = ConnectionManager()
        old_ws = FakeWebSocket()
        new_ws = FakeWebSocket()

        await manager.connect(old_ws, "thread-1")  # type: ignore[arg-type]
        await manager.connect(new_ws, "thread-1")  # type: ignore[arg-type]
        await manager.disconnect(old_ws, "thread-1")  # type: ignore[arg-type]
        await manager.send_to_thread({"event": "tool_start"}, "thread-1")

        self.assertTrue(old_ws.accepted)
        self.assertTrue(new_ws.accepted)
        self.assertEqual(manager.active_connections["thread-1"], new_ws)  # type: ignore[comparison-overlap]
        self.assertEqual(old_ws.sent, [])
        self.assertEqual(new_ws.sent, [{"event": "tool_start"}])

    async def test_monitor_emits_agui_payload_from_thread_context(self) -> None:
        fake_manager = FakeManager()
        monitor = Monitor()

        with tempfile.TemporaryDirectory() as tmp:
            with thread_scope("thread-1", Path(tmp)):
                original_manager = monitor_module.manager
                monitor_module.manager = fake_manager
                try:
                    await monitor.report_tool_start("item_search", {"query": "旅行收纳袋"})
                    await monitor.report_task_result("推荐结果")
                finally:
                    monitor_module.manager = original_manager

        self.assertEqual([thread_id for _, thread_id in fake_manager.sent], ["thread-1", "thread-1"])
        tool_start = fake_manager.sent[0][0]
        task_result = fake_manager.sent[1][0]

        self.assertEqual(tool_start["type"], "monitor_event")
        self.assertEqual(tool_start["event"], "tool_start")
        self.assertEqual(tool_start["data"], {
            "tool_name": "item_search",
            "args": {"query": "旅行收纳袋"},
        })
        self.assertIn("timestamp", tool_start)

        self.assertEqual(task_result["event"], "task_result")
        self.assertEqual(task_result["data"], {"final_answer": "推荐结果"})


if __name__ == "__main__":
    unittest.main()
