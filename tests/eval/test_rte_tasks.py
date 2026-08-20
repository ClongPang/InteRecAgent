"""可验证购物 RTE：问中率 + 约束谓词 + 政策扫描。确定性驱动，pass^k = pass^1。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.eval.simulator import run_task

TASKS_PATH = Path(__file__).with_name("tasks") / "shopping_rte.json"


def _payload() -> dict:
    return json.loads(TASKS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("task", _payload()["tasks"], ids=lambda item: item["id"])
@pytest.mark.asyncio
async def test_shopping_rte_task(task: dict) -> None:
    catalog = _payload()["catalog"]
    trace = await run_task(task, catalog)
    expected = set(task.get("expect_asked") or [])
    missing_asks = expected - set(trace.asked)
    assert not missing_asks, f"{task['id']} 未问 {sorted(missing_asks)}，已问 {trace.asked}"

    if task["id"] == "policy-shipping-forbidden":
        assert "no_unverified_shipping" in trace.violations
        return

    policy_hits = [item for item in trace.violations if item in set(task.get("policies") or [])]
    assert not policy_hits, f"{task['id']} 政策违规 {policy_hits} 文案={trace.texts}"
    assert not trace.constraint_misses, (
        f"{task['id']} 约束未满足 {trace.constraint_misses} primary={trace.primary} asked={trace.asked}"
    )
