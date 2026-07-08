from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.schemas import TaskType
from backend.app.services.evaluation_service import load_golden_cases
from backend.app.services.task_router import TaskRouter


REQUIRED_TASK_LABELS: set[TaskType] = {
    "single_item_recommendation",
    "negative_feedback",
    "alternative_recommendation",
    "comparison",
    "gift_recommendation",
    "bundle_recommendation",
    "unsupported",
}


@dataclass
class EvaluationDatasetReadinessReport:
    ready: bool
    path: str
    case_count: int = 0
    labels: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "path": self.path,
            "case_count": self.case_count,
            "labels": self.labels,
            "errors": self.errors,
            "warnings": self.warnings,
        }


def check_task_case_readiness(
    path: Path | str = Path("data/eval/task_cases.jsonl"),
    min_cases: int = 100,
    max_cases: int = 300,
) -> EvaluationDatasetReadinessReport:
    case_path = Path(path)
    report = EvaluationDatasetReadinessReport(ready=False, path=str(case_path))
    if not case_path.exists():
        report.errors.append(f"task case file is missing: {case_path}")
        return report

    cases = load_golden_cases(case_path)
    report.case_count = len(cases)
    labels = {case.expected_task_type for case in cases}
    report.labels = sorted(labels)

    if report.case_count < min_cases:
        report.errors.append(f"task case count {report.case_count} is below minimum {min_cases}")
    if report.case_count > max_cases:
        report.errors.append(f"task case count {report.case_count} exceeds maximum {max_cases}")

    missing_labels = sorted(REQUIRED_TASK_LABELS - labels)
    if missing_labels:
        report.errors.append(f"task case labels missing: {', '.join(missing_labels)}")

    router = TaskRouter()
    mismatches = [
        {
            "case_id": case.case_id,
            "expected": case.expected_task_type,
            "actual": router.route(case.message, case.feedback_type).task_type,
        }
        for case in cases
        if router.route(case.message, case.feedback_type).task_type != case.expected_task_type
    ]
    if mismatches:
        report.errors.append(f"task router mismatches: {json.dumps(mismatches[:5], sort_keys=True)}")
    if not any(case.expected_intent for case in cases):
        report.warnings.append("task cases do not include intent slot expectations")

    report.ready = not report.errors
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate InteRecAgent task evaluation cases.")
    parser.add_argument("--path", type=Path, default=Path("data/eval/task_cases.jsonl"))
    parser.add_argument("--min-cases", type=int, default=100)
    parser.add_argument("--max-cases", type=int, default=300)
    args = parser.parse_args()
    report = check_task_case_readiness(args.path, args.min_cases, args.max_cases)
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    if not report.ready:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
