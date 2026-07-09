from backend.app.services.evaluation_service import (
    REQUIRED_GOLDEN_SCENARIOS,
    EvaluationService,
    load_golden_cases,
    validate_golden_case_coverage,
)
from backend.app.services.evaluation_case_generator import generate_task_cases, write_task_cases
from backend.app.services.evaluation_dataset_readiness import check_task_case_readiness
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
    assert summary.readiness["passed"] is False
    assert summary.readiness["gates"]["evidence_coverage"]["passed"] is False
    assert summary.readiness["gates"]["final_validation_violation_rate"]["passed"] is True
    assert summary.readiness["gates"]["unknown_critical_constraint_rate"]["actual"] == 0.5
    assert summary.readiness["gates"]["unknown_critical_constraint_rate"]["passed"] is False
    assert summary.case_results[0]["case_id"] == "task_headphones_simple_001"
    assert summary.case_results[0]["actual_task_type"] == "single_item_recommendation"
    assert any(result["scenario"] == "unsupported_checkout" for result in summary.case_results)


def test_evaluation_service_loads_jsonl_golden_cases_by_default():
    cases = load_golden_cases()

    assert [case.case_id for case in cases] == [
        "task_headphones_simple_001",
        "clarification_work_001",
        "task_headphones_budget_001",
        "feedback_brand_001",
        "feedback_price_001",
        "unsupported_checkout_001",
    ]
    assert cases[1].expected_status == "clarification_required"
    assert {case.scenario for case in cases} == REQUIRED_GOLDEN_SCENARIOS
    assert validate_golden_case_coverage(cases) == []


def test_generated_task_cases_cover_required_evaluation_scale_and_labels(tmp_path):
    output_path = tmp_path / "task_cases.jsonl"
    write_task_cases(output_path)
    cases = load_golden_cases(output_path)
    generated = generate_task_cases()

    assert len(generated) == 140
    assert len(cases) == 140
    assert 100 <= len(cases) <= 300
    assert {case.expected_task_type for case in cases} == {
        "single_item_recommendation",
        "negative_feedback",
        "alternative_recommendation",
        "comparison",
        "gift_recommendation",
        "bundle_recommendation",
        "unsupported",
    }
    assert any(case.expected_intent.get("budget.max") == 100.0 for case in cases)


def test_generated_task_cases_match_task_router_labels():
    router = TaskRouter()
    cases = generate_task_cases()

    mismatches = [
        (case["case_id"], case["expected_task_type"], router.route(case["message"], case.get("feedback_type")).task_type)
        for case in cases
        if router.route(case["message"], case.get("feedback_type")).task_type != case["expected_task_type"]
    ]

    assert mismatches == []


def test_task_case_readiness_passes_for_generated_dataset(tmp_path):
    output_path = tmp_path / "task_cases.jsonl"
    write_task_cases(output_path)

    report = check_task_case_readiness(output_path)

    assert report.ready is True
    assert report.case_count == 140
    assert "bundle_recommendation" in report.labels
    assert report.errors == []


def test_task_case_readiness_reports_missing_or_incomplete_dataset(tmp_path):
    missing_report = check_task_case_readiness(tmp_path / "missing.jsonl")
    incomplete_path = tmp_path / "incomplete.jsonl"
    incomplete_path.write_text(
        '{"case_id":"one","message":"Recommend wireless headphones.","expected_task_type":"single_item_recommendation"}\n',
        encoding="utf-8",
    )

    incomplete_report = check_task_case_readiness(incomplete_path)

    assert missing_report.ready is False
    assert any("missing" in error for error in missing_report.errors)
    assert incomplete_report.ready is False
    assert any("below minimum" in error for error in incomplete_report.errors)
    assert any("labels missing" in error for error in incomplete_report.errors)


def test_evaluation_service_reports_metrics_from_jsonl_golden_cases(tmp_path):
    golden_path = tmp_path / "golden_cases.jsonl"
    golden_path.write_text(
        "\n".join(
            [
                '{"case_id":"jsonl_budget","message":"Recommend wireless headphones under 100 dollars for commuting.","expected_task_type":"single_item_recommendation","expected_intent":{"category":"wireless headphones","budget.max":100.0},"hard_constraints":[{"field":"price","op":"<=","value":100.0}]}',
                '{"case_id":"jsonl_clarify","message":"I need something for work","expected_task_type":"single_item_recommendation","expected_status":"clarification_required"}',
                '{"case_id":"jsonl_feedback","message":"Too expensive","expected_task_type":"negative_feedback","expected_status":"recommendations_ready","expected_feedback":{"price_sensitivity":"high"},"feedback_type":"price","anchor_product_id":"prod_headphones_001"}',
                '{"case_id":"jsonl_unsupported","message":"Can you check shipping?","expected_task_type":"unsupported","expected_status":"unsupported"}',
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
    assert "unsupported_claim_rate" in summary.readiness["gates"]
    assert "unknown_critical_constraint_rate" in summary.readiness["gates"]
    assert [result["case_id"] for result in summary.case_results] == [
        "jsonl_budget",
        "jsonl_clarify",
        "jsonl_feedback",
        "jsonl_unsupported",
    ]


def test_evaluation_service_records_status_failures(tmp_path):
    golden_path = tmp_path / "golden_cases.jsonl"
    golden_path.write_text(
        '{"case_id":"jsonl_status","message":"I need something for work","expected_task_type":"single_item_recommendation","expected_status":"recommendations_ready"}\n',
        encoding="utf-8",
    )

    summary = EvaluationService(golden_cases_path=golden_path).run()

    assert any(
        failure["metric"] == "status"
        and failure["case_id"] == "jsonl_status"
        and failure["expected"] == "recommendations_ready"
        and failure["actual"] == "clarification_required"
        for failure in summary.case_failures
    )


def test_evaluation_service_records_missing_golden_case_coverage(tmp_path):
    golden_path = tmp_path / "golden_cases.jsonl"
    golden_path.write_text(
        '{"case_id":"jsonl_simple","scenario":"simple_recommendation","message":"Recommend wireless headphones.","expected_task_type":"single_item_recommendation"}\n',
        encoding="utf-8",
    )

    summary = EvaluationService(golden_cases_path=golden_path).run()

    coverage_failure = next(
        failure
        for failure in summary.case_failures
        if failure["metric"] == "golden_case_coverage"
    )
    assert "clarification" in coverage_failure["missing"]
    assert "unsupported_checkout" in coverage_failure["missing"]
    assert summary.readiness["gates"]["golden_case_coverage"]["passed"] is False


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
    failed_result = next(
        result for result in summary.case_results if result["case_id"] == "unsupported_checkout_001"
    )
    assert failed_result["passed"] is False
