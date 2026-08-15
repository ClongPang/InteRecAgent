from __future__ import annotations

import asyncio
import unittest
from typing import Any

from app.harness.hooks.phase_check import (
    check_phase_permission,
    check_user_tier_permission,
)
from app.harness.hooks.phase_transition import try_phase_transition
from app.harness.middleware import HookRejectSignal
from app.harness.phase_machine import Phase, phase_machine
from app.harness.tool_filter import get_filtered_tool_names
from app.observability.trace_ctx import set_langfuse_trace


class RecordingTrace:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def event(
        self,
        name: str,
        input: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.events.append({
            "name": name,
            "input": input,
            "metadata": metadata,
        })


class DynamicToolPermissionTests(unittest.TestCase):
    def tearDown(self) -> None:
        set_langfuse_trace(None)

    def test_user_tier_filter_hides_dispatch_for_free_users(self) -> None:
        thread_id = "tier-filter-test"
        phase_machine.set_phase(Phase.SEARCHING, thread_id)

        free_tools = get_filtered_tool_names(thread_id, user_tier="free")
        standard_tools = get_filtered_tool_names(thread_id, user_tier="standard")

        self.assertNotIn("dispatch_tool", free_tools)
        self.assertIn("dispatch_tool", standard_tools)

    def test_user_tier_hook_rejects_free_dispatch(self) -> None:
        with self.assertRaises(HookRejectSignal):
            asyncio.run(check_user_tier_permission({
                "tool_name": "dispatch_tool",
                "user_tier": "free",
            }))

        result = asyncio.run(check_user_tier_permission({
            "tool_name": "dispatch_tool",
            "user_tier": "standard",
        }))
        self.assertIsNone(result)

    def test_phase_transition_records_trace_event(self) -> None:
        thread_id = "phase-transition-trace-test"
        trace = RecordingTrace()
        set_langfuse_trace(trace)
        phase_machine.set_phase(Phase.PLANNING, thread_id)

        result = asyncio.run(try_phase_transition({
            "thread_id": thread_id,
            "planner_output_ready": True,
        }))

        self.assertEqual(result, {"phase": "searching"})
        self.assertEqual(trace.events[0]["name"], "phase_transition")
        self.assertEqual(trace.events[0]["input"], {
            "from": "planning",
            "to": "searching",
            "trigger": "planner_output_ready",
        })

    def test_phase_rejection_records_trace_event(self) -> None:
        thread_id = "phase-rejection-trace-test"
        trace = RecordingTrace()
        set_langfuse_trace(trace)
        phase_machine.set_phase(Phase.PLANNING, thread_id)

        with self.assertRaises(HookRejectSignal):
            asyncio.run(check_phase_permission({
                "thread_id": thread_id,
                "tool_name": "item_search",
            }))

        self.assertEqual(trace.events[0]["name"], "tool_rejected_by_phase")
        self.assertEqual(trace.events[0]["input"]["tool"], "item_search")
        self.assertEqual(trace.events[0]["input"]["phase"], "planning")
        self.assertIn("planner", trace.events[0]["input"]["allowed"])


if __name__ == "__main__":
    unittest.main()
