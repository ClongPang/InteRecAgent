from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.compress.breakpoint import compute_breakpoint
from app.compress.compressor import compress_after_breakpoint
from app.compress.context_manager import build_context


class CacheBreakpointTests(unittest.TestCase):
    def test_compute_breakpoint_uses_recent_tool_messages(self) -> None:
        messages = [
            {"role": "system", "content": "stable"},
            {"role": "tool", "content": "planner"},
            {"role": "assistant", "content": "next"},
            {"role": "tool", "content": "item_search"},
            {"role": "assistant", "content": "next"},
            {"role": "tool", "content": "price_compare"},
        ]

        self.assertEqual(compute_breakpoint(messages, keep_recent=2), 3)
        self.assertEqual(compute_breakpoint(messages, keep_recent=3), len(messages))

    def test_compress_after_breakpoint_keeps_prefix_unchanged(self) -> None:
        messages = [
            {"role": "system", "content": "stable"},
            {"role": "tool", "content": "old tool result " + "x" * 200},
            {"role": "assistant", "content": "next"},
            {"role": "tool", "content": "new tool result " + "y" * 200},
        ]

        compressed = compress_after_breakpoint(
            messages,
            breakpoint_idx=2,
            max_tool_result_chars=40,
        )

        self.assertEqual(compressed[0], messages[0])
        self.assertEqual(compressed[1], messages[1])
        self.assertIn("[...内容已精简]", compressed[3]["content"])
        self.assertEqual(compressed[3]["original_chars"], len(messages[3]["content"]))

    def test_build_context_loads_state_and_compresses_messages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp)
            (session_dir / "hot_context.json").write_text(
                json.dumps({"latest_observation": "亚马逊返回 20 件"}),
                encoding="utf-8",
            )
            (session_dir / "task_state.json").write_text(
                json.dumps({"goal": "推荐旅行三件套", "budget": "300 元以内"}),
                encoding="utf-8",
            )
            (session_dir / "working_memory.json").write_text(
                json.dumps({"user_preferences": ["avoid_plastic"]}),
                encoding="utf-8",
            )
            (session_dir / "messages.json").write_text(
                json.dumps([
                    {"role": "assistant", "content": "开始检索"},
                    {"role": "tool", "content": "item_search: " + "商品;" * 200},
                ]),
                encoding="utf-8",
            )

            context = build_context(
                thread_id="thread-test",
                session_dir=session_dir,
                current_request="继续比较",
                long_term_preferences="- 不要塑料",
                keep_recent_tools=0,
                max_tool_result_chars=80,
            )

        self.assertEqual(context[-1], {"role": "user", "content": "继续比较"})
        self.assertTrue(any("task_state" in message["content"] for message in context))
        self.assertTrue(any("working_memory" in message["content"] for message in context))
        self.assertIn("[...内容已精简]", context[-2]["content"])


if __name__ == "__main__":
    unittest.main()
