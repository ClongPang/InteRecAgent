from __future__ import annotations

from typing import Any

from app.eval.rubric import evaluate_trajectory


async def judge_trajectory(trajectory: dict[str, Any]) -> dict[str, Any]:
    """Return the bootstrap rubric score for an Agent trajectory."""
    return await evaluate_trajectory(trajectory)
