from backend.app.services.evaluation_service import EvaluationService


def test_evaluation_service_reports_required_metrics():
    summary = EvaluationService().run()

    assert summary.metrics["task_type_accuracy"] == 1.0
    assert set(summary.metrics) == {
        "task_type_accuracy",
        "intent_slot_f1",
        "constraint_satisfaction",
        "evidence_coverage",
        "feedback_recovery",
    }
    assert summary.case_failures == []
