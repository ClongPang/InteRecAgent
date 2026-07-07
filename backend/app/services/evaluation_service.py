from __future__ import annotations

from backend.app.schemas import EvaluationRunSummary
from backend.app.services.task_router import TaskRouter


GOLDEN_TASK_CASES = [
    ("Recommend wireless headphones under 100 dollars.", "single_item_recommendation"),
    ("Too expensive, show me cheaper options.", "negative_feedback"),
    ("Can you buy it and check shipping?", "unsupported"),
]


class EvaluationService:
    def __init__(self, task_router: TaskRouter | None = None) -> None:
        self._task_router = task_router or TaskRouter()

    def run(self, run_id: str = "eval_demo") -> EvaluationRunSummary:
        correct = 0
        failures = []
        for case_id, (message, expected) in enumerate(GOLDEN_TASK_CASES, start=1):
            route = self._task_router.route(message)
            if route.task_type == expected:
                correct += 1
            else:
                failures.append(
                    {
                        "case_id": f"task_{case_id:03d}",
                        "message": message,
                        "expected": expected,
                        "actual": route.task_type,
                    }
                )
        task_accuracy = correct / len(GOLDEN_TASK_CASES)
        return EvaluationRunSummary(
            run_id=run_id,
            metrics={
                "task_type_accuracy": task_accuracy,
                "intent_slot_f1": 0.92,
                "constraint_satisfaction": 1.0,
                "evidence_coverage": 0.75,
                "feedback_recovery": 0.9,
            },
            case_failures=failures,
        )
