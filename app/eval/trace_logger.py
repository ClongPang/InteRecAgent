from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TRACE_PATH = PROJECT_ROOT / "data" / "eval" / "trajectories.jsonl"
DEFAULT_RAR_EVAL_PATH = PROJECT_ROOT / "data" / "eval" / "rar_evaluations.jsonl"
DEFAULT_SFT_CANDIDATE_PATH = PROJECT_ROOT / "data" / "eval" / "sft_candidates.jsonl"


def append_trajectory(
    trajectory: dict[str, Any],
    path: Path = DEFAULT_TRACE_PATH,
) -> None:
    _append_jsonl(trajectory, path)


def append_evaluation_record(
    trajectory: dict[str, Any],
    score: dict[str, Any],
    path: Path = DEFAULT_RAR_EVAL_PATH,
) -> None:
    _append_jsonl({
        "query": trajectory.get("query") or trajectory.get("user_query"),
        "trajectory": trajectory,
        "score": score,
    }, path)


def append_sft_candidate(
    trajectory: dict[str, Any],
    score: dict[str, Any],
    path: Path = DEFAULT_SFT_CANDIDATE_PATH,
    threshold: float = 70.0,
) -> bool:
    if not score.get("passed") or float(score.get("total", 0)) < threshold:
        return False

    _append_jsonl({
        "query": trajectory.get("query") or trajectory.get("user_query"),
        "final": trajectory.get("final") or trajectory.get("final_text"),
        "trajectory": trajectory,
        "score": score,
    }, path)
    return True


def _append_jsonl(payload: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
