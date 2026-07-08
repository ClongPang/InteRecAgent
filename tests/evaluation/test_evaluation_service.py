from backend.app.services.evaluation_service import EvaluationService, load_golden_cases
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


def test_evaluation_service_loads_jsonl_golden_cases_by_default():
    cases = load_golden_cases()

    assert [case.case_id for case in cases] == [
        "task_headphones_budget_001",
        "feedback_price_001",
        "unsupported_checkout_001",
    ]


def test_evaluation_service_reports_metrics_from_jsonl_golden_cases(tmp_path):
    golden_path = tmp_path / "golden_cases.jsonl"
    golden_path.write_text(
        "\n".join(
            [
                '{"case_id":"jsonl_budget","message":"Recommend wireless headphones under 100 dollars for commuting.","expected_task_type":"single_item_recommendation","expected_intent":{"category":"wireless headphones","budget.max":100.0},"hard_constraints":[{"field":"price","op":"<=","value":100.0}]}',
                '{"case_id":"jsonl_feedback","message":"Too expensive","expected_task_type":"negative_feedback","expected_feedback":{"price_sensitivity":"high"},"feedback_type":"price","anchor_product_id":"prod_headphones_001"}',
                '{"case_id":"jsonl_unsupported","message":"Can you check shipping?","expected_task_type":"unsupported"}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    summary = EvaluationService(golden_cases_path=golden_path).run()

    assert set(summary.metrics) == {
        "task_type_accuracy",
        "intent_slot_f1",
        "constraint_satisfaction",
        "evidence_coverage",
        "feedback_recovery",
    }
    assert summary.metrics["task_type_accuracy"] == 1.0
    assert any(failure["case_id"] == "jsonl_budget" for failure in summary.case_failures)


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
