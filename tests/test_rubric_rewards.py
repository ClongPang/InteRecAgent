from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.eval.rubric import evaluate_trajectory, is_sft_candidate
from app.eval.trace_logger import append_evaluation_record, append_sft_candidate


class RubricRewardTests(unittest.IsolatedAsyncioTestCase):
    async def test_high_quality_trace_becomes_sft_candidate(self) -> None:
        trajectory = {
            "query": "送给粉丝的礼物预算 100 元以内，给男生，会喝酒，不要玩具，想要有趣帅气",
            "tool_calls": [
                "planner",
                "category_insight",
                "item_search",
                "price_compare",
                "item_picker",
                "shopping_summary",
            ],
            "picks": [{"title": "男生酒杯套装", "price": 89}],
            "final": (
                "推荐男生酒杯套装，¥89，适合作为粉丝礼物。理由：不是玩具，"
                "兼顾喝酒场景和有趣帅气表达；建议搭配卡片形成组合，材质和预算都更稳。"
            ),
        }

        score = await evaluate_trajectory(trajectory)

        self.assertEqual(score["p0"], "pass")
        self.assertGreaterEqual(score["total"], 70)
        self.assertTrue(is_sft_candidate(score))
        self.assertTrue(score["sft_candidate"])

    async def test_p0_failure_blocks_score_even_when_answer_is_verbose(self) -> None:
        trajectory = {
            "query": "送给男生的礼物，预算 100 元以内，不要玩具",
            "tool_calls": ["planner", "item_search", "shopping_summary"],
            "final": (
                "推荐女款玩具礼盒，¥199。推荐理由：包装好看，预算稍高但可以接受。"
                "内部 item_id=abc123。"
            ),
        }

        score = await evaluate_trajectory(trajectory)

        self.assertEqual(score["p0"], "fail")
        self.assertEqual(score["total"], 0)
        self.assertFalse(score["passed"])
        self.assertIn("泄露内部 ID 或工具名", score["p0_failures"])

    async def test_trace_logger_writes_eval_and_sft_candidate(self) -> None:
        trajectory = {"query": "旅行收纳袋预算 100 元", "final": "推荐帆布旅行收纳袋，¥59，推荐理由：便携耐用，预算内。"}
        score = await evaluate_trajectory(trajectory)

        with tempfile.TemporaryDirectory() as tmp:
            eval_path = Path(tmp) / "rar.jsonl"
            sft_path = Path(tmp) / "sft.jsonl"

            append_evaluation_record(trajectory, score, eval_path)
            wrote_sft = append_sft_candidate(trajectory, score, sft_path, threshold=0)

            eval_record = json.loads(eval_path.read_text(encoding="utf-8").splitlines()[0])
            sft_record = json.loads(sft_path.read_text(encoding="utf-8").splitlines()[0])

        self.assertEqual(eval_record["query"], trajectory["query"])
        self.assertEqual(eval_record["score"]["total"], score["total"])
        self.assertTrue(wrote_sft)
        self.assertEqual(sft_record["trajectory"]["final"], trajectory["final"])


if __name__ == "__main__":
    unittest.main()
