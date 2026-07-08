from backend.app.services.evaluation_service import EvaluationService
from backend.app.services.task_router import TaskRoute, TaskRouter


def test_evaluation_service_reports_required_metrics():
    summary = EvaluationService().run()

    assert summary.metrics["task_type_accuracy"] == 1.0
    assert summary.metrics["intent_slot_f1"] == 1.0
    assert summary.metrics["constraint_satisfaction"] == 1.0
    assert 0 < summary.metrics["evidence_coverage"] < 1.0
    assert summary.metrics["feedback_recovery"] == 1.0
    assert set(summary.metrics) == {
        "task_type_accuracy",
        "intent_slot_f1",
        "constraint_satisfaction",
        "evidence_coverage",
        "feedback_recovery",
    }
    assert any(failure["metric"] == "evidence_coverage" for failure in summary.case_failures)


class BrokenTaskRouter(TaskRouter):
    def route(self, message: str, feedback_type: str | None = None) -> TaskRoute:
        route = super().route(message, feedback_type)
        if "shipping" in message:
            return TaskRoute("single_item_recommendation", 0.2, "intentional test mismatch")
        return route


def test_evaluation_service_records_task_type_failures():
    summary = EvaluationService(task_router=BrokenTaskRouter()).run()

    assert summary.metrics["task_type_accuracy"] < 1.0
    assert any(
        failure["metric"] == "task_type_accuracy"
        and failure["expected"] == "unsupported"
        and failure["actual"] == "single_item_recommendation"
        for failure in summary.case_failures
    )
