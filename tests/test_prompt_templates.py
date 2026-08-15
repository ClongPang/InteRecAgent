from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.agent.prompts import (
    build_system_reminder,
    format_rubric_judge_prompt,
    format_dispatch_demands,
    get_conversation_summary_prompt,
    get_dispatch_demands_template,
    get_planner_prompt,
    get_session_summary_prompt,
    get_system_prompt,
    get_tool_result_compress_prompt,
    get_tool_result_compression_decision_prompt,
)
from app.agent.dispatch_tool import dispatch_tool
from app.compress.context_manager import build_context
from app.tools.planner import MaterialPreference, PlannerOutput


class PromptTemplateTests(unittest.TestCase):
    def test_system_prompt_keeps_long_term_preferences_at_tail(self) -> None:
        prompt = get_system_prompt("- 不要塑料")

        self.assertIn("<role>", prompt)
        self.assertIn("<constraints>", prompt)
        self.assertIn("<loop>", prompt)
        self.assertIn("<tool_policy>", prompt)
        self.assertIn("<examples>", prompt)
        self.assertIn("<user_preferences>", prompt)
        self.assertIn("缓存友好纪律", prompt)
        self.assertIn("- 不要塑料", prompt)
        self.assertLess(prompt.index("<examples>"), prompt.index("<user_preferences>"))
        self.assertTrue(prompt.rstrip().endswith("</user_preferences>"))

    def test_system_prompt_contains_tool_policy_routing(self) -> None:
        prompt = get_system_prompt()

        self.assertIn("当下一步是单个原子操作时", prompt)
        self.assertIn("只有单一、明确的查询", prompt)
        self.assertIn("When NOT to fork", prompt)
        self.assertIn("不要为闲聊启动 Planner / 检索 / fork", prompt)
        self.assertIn("商品检索本身别用它，用 ItemSearch", prompt)
        self.assertIn("不要返回原始 API 全量响应", prompt)
        self.assertLess(prompt.index("非购物意图"), prompt.index("复杂多约束意图"))
        self.assertLess(prompt.index("复杂多约束意图"), prompt.index("满足 fork 三件事"))
        self.assertLess(prompt.index("满足 fork 三件事"), prompt.index("其余情况"))

    def test_dispatch_demands_template_is_available(self) -> None:
        template = get_dispatch_demands_template()

        self.assertIn("dispatch_tool(demands=...)", template)
        self.assertIn("硬约束", template)
        self.assertIn("Top <N>", template)
        self.assertIn("不要返回原始 API 全量响应", template)

    def test_dispatch_demands_formatter_outputs_self_contained_prompt(self) -> None:
        demands = format_dispatch_demands(
            platform="amazon",
            category="旅行三件套",
            hard_constraints=["预算<=300", "不含塑料"],
            soft_preferences=["小众风格"],
            top_n=3,
        )

        self.assertIn("amazon", demands)
        self.assertIn("旅行三件套", demands)
        self.assertIn("预算<=300 / 不含塑料", demands)
        self.assertIn("Top 3", demands)
        self.assertIn("不要返回原始 API 全量响应", demands)

    def test_dispatch_tool_description_includes_fork_guardrails(self) -> None:
        description = dispatch_tool.description

        self.assertIn("stateless", description)
        self.assertIn("自包含", description)
        self.assertIn("Do not use when", description)
        self.assertIn("二次 fork", description)

    def test_planner_prompt_requires_strict_json_fields(self) -> None:
        prompt = get_planner_prompt()

        self.assertIn('"platforms": string[]', prompt)
        self.assertIn('"material_pref": {"exclude": string[], "prefer": string[]}', prompt)
        self.assertIn("只输出 JSON", prompt)
        self.assertIn("NEVER 编造", prompt)

    def test_meta_prompts_are_available(self) -> None:
        compression_prompt = get_tool_result_compression_decision_prompt()
        summary_prompt = get_conversation_summary_prompt()
        page_named_compression_prompt = get_tool_result_compress_prompt()
        page_named_summary_prompt = get_session_summary_prompt()

        self.assertIn("<should_compress>true/false</should_compress>", compression_prompt)
        self.assertIn("已排除的商品和原因", summary_prompt)
        self.assertIn("只输出结构化摘要", summary_prompt)
        self.assertEqual(compression_prompt, page_named_compression_prompt)
        self.assertEqual(summary_prompt, page_named_summary_prompt)

    def test_rubric_judge_prompt_formats_dynamic_items(self) -> None:
        prompt = format_rubric_judge_prompt(
            p0_items=["不能违反预算"],
            p1_items=[{"dimension": "工具顺序", "description": "检索应早于总结"}],
            p2_items=["提供组合建议"],
        )

        self.assertIn("- 不能违反预算", prompt)
        self.assertIn("- 工具顺序: 检索应早于总结", prompt)
        self.assertIn("- 提供组合建议", prompt)
        self.assertNotIn("{p0_items}", prompt)

    def test_system_reminder_is_inserted_before_current_user_message(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = build_context(
                thread_id="thread-reminder",
                session_dir=Path(tmp),
                current_request="继续比较",
                system_reminders={
                    "当前平台状态": "amazon 本轮超时，请勿再派发给它",
                    "预算已更新为": 500,
                },
            )

        self.assertEqual(context[-1], {"role": "user", "content": "继续比较"})
        self.assertIn("<system-reminder>", context[-2]["content"])
        self.assertIn("amazon 本轮超时", context[-2]["content"])
        self.assertIn("预算已更新为: 500", context[-2]["content"])

    def test_planner_output_schema_matches_prompt_shape(self) -> None:
        output = PlannerOutput(
            budget=500,
            category="旅行收纳",
            material_pref=MaterialPreference(exclude=["塑料"], prefer=["帆布"]),
            platforms=["shopee", "ebay"],
            hard_constraints=["不要塑料"],
        )

        data = output.model_dump()

        self.assertEqual(data["budget"], 500)
        self.assertEqual(data["material_pref"]["exclude"], ["塑料"])
        self.assertEqual(data["platforms"], ["shopee", "ebay"])
        self.assertEqual(data["soft_preferences"], [])


if __name__ == "__main__":
    unittest.main()
