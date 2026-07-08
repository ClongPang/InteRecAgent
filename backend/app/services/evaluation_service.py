from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.schemas import ChatRequest, ChatTurnResponse
from backend.app.schemas import EvaluationRunSummary
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.task_router import TaskRouter


@dataclass(frozen=True)
class GoldenCase:
    case_id: str
    message: str
    expected_task_type: str
    scenario: str | None = None
    expected_status: str | None = None
    expected_intent: dict[str, Any] = field(default_factory=dict)
    hard_constraints: list[dict[str, Any]] = field(default_factory=list)
    expected_feedback: dict[str, Any] = field(default_factory=dict)
    feedback_type: str | None = None
    anchor_product_id: str | None = None


DEFAULT_GOLDEN_CASES_PATH = Path("data/eval/golden_cases.jsonl")

REQUIRED_GOLDEN_SCENARIOS = {
    "simple_recommendation",
    "clarification",
    "budget_constraint",
    "brand_rejection",
    "cheaper_alternative",
    "unsupported_checkout",
}

MVP_READINESS_THRESHOLDS = {
    "task_type_accuracy": {"operator": ">=", "threshold": 0.95},
    "intent_slot_f1": {"operator": ">=", "threshold": 0.9},
    "constraint_satisfaction": {"operator": ">=", "threshold": 1.0},
    "evidence_coverage": {"operator": ">=", "threshold": 0.8},
    "feedback_recovery": {"operator": ">=", "threshold": 0.9},
    "unsupported_claim_rate": {"operator": "<=", "threshold": 0.2},
    "final_validation_violation_rate": {"operator": "<=", "threshold": 0.0},
}


GOLDEN_CASES = [
    GoldenCase(
        case_id="task_headphones_budget_001",
        message="Recommend wireless headphones under 100 dollars for commuting.",
        expected_task_type="single_item_recommendation",
        expected_intent={
            "category": "wireless headphones",
            "budget.max": 100.0,
            "goal": "commuting",
        },
        hard_constraints=[{"field": "price", "op": "<=", "value": 100.0}],
    ),
    GoldenCase(
        case_id="feedback_price_001",
        message="Too expensive",
        expected_task_type="negative_feedback",
        expected_feedback={"price_sensitivity": "high"},
        feedback_type="price",
        anchor_product_id="prod_headphones_001",
    ),
    GoldenCase(
        case_id="unsupported_checkout_001",
        message="Can you buy it and check shipping?",
        expected_task_type="unsupported",
    ),
]


def load_golden_cases(path: Path | str = DEFAULT_GOLDEN_CASES_PATH) -> list[GoldenCase]:
    golden_path = Path(path)
    if not golden_path.exists():
        return []
    cases: list[GoldenCase] = []
    with golden_path.open("r", encoding="utf-8") as case_file:
        for line in case_file:
            if not line.strip():
                continue
            cases.append(GoldenCase(**json.loads(line)))
    return cases


def validate_golden_case_coverage(
    cases: list[GoldenCase],
    required_scenarios: set[str] = REQUIRED_GOLDEN_SCENARIOS,
) -> list[str]:
    present = {case.scenario for case in cases if case.scenario}
    return sorted(required_scenarios - present)


class EvaluationService:
    def __init__(
        self,
        task_router: TaskRouter | None = None,
        orchestrator: ChatOrchestrator | None = None,
        golden_cases: list[GoldenCase] | None = None,
        golden_cases_path: Path | str = DEFAULT_GOLDEN_CASES_PATH,
    ) -> None:
        self._task_router = task_router or TaskRouter()
        self._orchestrator = orchestrator or ChatOrchestrator()
        self._golden_cases = golden_cases or load_golden_cases(golden_cases_path) or GOLDEN_CASES

    def run(self, run_id: str = "eval_demo") -> EvaluationRunSummary:
        responses = [
            (case, self._orchestrator.run(self._request_for_case(case)))
            for case in self._golden_cases
        ]
        failures: list[dict[str, Any]] = []
        task_accuracy = self._task_type_accuracy(failures)
        intent_f1 = self._intent_slot_f1(responses, failures)
        constraint_satisfaction = self._constraint_satisfaction(responses, failures)
        evidence_coverage = self._evidence_coverage(responses, failures)
        feedback_recovery = self._feedback_recovery(responses, failures)
        self._status_expectations(responses, failures)
        self._golden_case_coverage(failures)
        metrics = {
            "task_type_accuracy": task_accuracy,
            "intent_slot_f1": intent_f1,
            "constraint_satisfaction": constraint_satisfaction,
            "evidence_coverage": evidence_coverage,
            "feedback_recovery": feedback_recovery,
        }
        return EvaluationRunSummary(
            run_id=run_id,
            metrics=metrics,
            readiness=self._readiness_report(metrics, failures),
            case_failures=failures,
        )

    def _request_for_case(self, case: GoldenCase) -> ChatRequest:
        return ChatRequest(
            session_id=f"sess_{case.case_id}",
            turn_id=f"turn_{case.case_id}",
            message=case.message,
            feedback_text=case.message if case.feedback_type else None,
            feedback_type=case.feedback_type,
            anchor_product_id=case.anchor_product_id,
        )

    def _task_type_accuracy(self, failures: list[dict[str, Any]]) -> float:
        correct = 0
        for case in self._golden_cases:
            route = self._task_router.route(case.message, case.feedback_type)
            if route.task_type == case.expected_task_type:
                correct += 1
            else:
                failures.append(
                    {
                        "metric": "task_type_accuracy",
                        "case_id": case.case_id,
                        "message": case.message,
                        "expected": case.expected_task_type,
                        "actual": route.task_type,
                    }
                )
        return correct / len(self._golden_cases) if self._golden_cases else 0.0

    def _status_expectations(
        self,
        responses: list[tuple[GoldenCase, ChatTurnResponse]],
        failures: list[dict[str, Any]],
    ) -> None:
        for case, response in responses:
            if case.expected_status and response.status != case.expected_status:
                failures.append(
                    {
                        "metric": "status",
                        "case_id": case.case_id,
                        "message": case.message,
                        "expected": case.expected_status,
                        "actual": response.status,
                    }
                )

    def _golden_case_coverage(self, failures: list[dict[str, Any]]) -> None:
        missing = validate_golden_case_coverage(self._golden_cases)
        if missing:
            failures.append(
                {
                    "metric": "golden_case_coverage",
                    "expected": sorted(REQUIRED_GOLDEN_SCENARIOS),
                    "actual": sorted(
                        case.scenario for case in self._golden_cases if case.scenario
                    ),
                    "missing": missing,
                }
            )

    def _intent_slot_f1(
        self,
        responses: list[tuple[GoldenCase, ChatTurnResponse]],
        failures: list[dict[str, Any]],
    ) -> float:
        expected_count = 0
        correct_count = 0
        extracted_count = 0
        for case, response in responses:
            if not case.expected_intent:
                continue
            actual_values = response.intent_state.model_dump()
            for path, expected_value in case.expected_intent.items():
                expected_count += 1
                actual_value = self._get_path(actual_values, path)
                if actual_value not in (None, "", [], {}):
                    extracted_count += 1
                if actual_value == expected_value:
                    correct_count += 1
                else:
                    failures.append(
                        {
                            "metric": "intent_slot_f1",
                            "case_id": case.case_id,
                            "field": path,
                            "expected": expected_value,
                            "actual": actual_value,
                        }
                    )
        if expected_count == 0:
            return 1.0
        precision = correct_count / extracted_count if extracted_count else 0.0
        recall = correct_count / expected_count
        if precision + recall == 0:
            return 0.0
        return round(2 * precision * recall / (precision + recall), 4)

    def _constraint_satisfaction(
        self,
        responses: list[tuple[GoldenCase, ChatTurnResponse]],
        failures: list[dict[str, Any]],
    ) -> float:
        total = 0
        satisfied = 0
        for case, response in responses:
            if not case.hard_constraints:
                continue
            for product in response.products:
                total += 1
                if product.constraint_status != "violated":
                    satisfied += 1
                else:
                    failures.append(
                        {
                            "metric": "constraint_satisfaction",
                            "case_id": case.case_id,
                            "product_id": product.product_id,
                            "expected": "no hard-constraint violations",
                            "actual": product.constraint_status,
                        }
                    )
        return satisfied / total if total else 1.0

    def _evidence_coverage(
        self,
        responses: list[tuple[GoldenCase, ChatTurnResponse]],
        failures: list[dict[str, Any]],
    ) -> float:
        total_claims = 0
        supported_claims = 0
        for case, response in responses:
            for product in response.products:
                for claim in product.claim_evidence:
                    total_claims += 1
                    if claim.supported:
                        supported_claims += 1
                    else:
                        failures.append(
                            {
                                "metric": "evidence_coverage",
                                "case_id": case.case_id,
                                "product_id": product.product_id,
                                "expected": "supported claim",
                                "actual": claim.claim,
                            }
                        )
        return supported_claims / total_claims if total_claims else 1.0

    def _feedback_recovery(
        self,
        responses: list[tuple[GoldenCase, ChatTurnResponse]],
        failures: list[dict[str, Any]],
    ) -> float:
        feedback_cases = [(case, response) for case, response in responses if case.expected_feedback]
        if not feedback_cases:
            return 1.0
        recovered = 0
        for case, response in feedback_cases:
            checks = 0
            correct = 0
            actual_values = response.intent_state.model_dump()
            for path, expected_value in case.expected_feedback.items():
                checks += 1
                actual_value = self._get_path(actual_values, path)
                if actual_value == expected_value:
                    correct += 1
                else:
                    failures.append(
                        {
                            "metric": "feedback_recovery",
                            "case_id": case.case_id,
                            "field": path,
                            "expected": expected_value,
                            "actual": actual_value,
                        }
                    )
            if checks and checks == correct:
                recovered += 1
        return recovered / len(feedback_cases)

    def _get_path(self, values: dict[str, Any], path: str) -> Any:
        current: Any = values
        for part in path.split("."):
            if isinstance(current, dict):
                current = current.get(part)
            else:
                return None
        return current

    def _readiness_report(
        self,
        metrics: dict[str, float],
        failures: list[dict[str, Any]],
    ) -> dict[str, Any]:
        actuals = {
            **metrics,
            "unsupported_claim_rate": round(1.0 - metrics["evidence_coverage"], 4),
            "final_validation_violation_rate": round(1.0 - metrics["constraint_satisfaction"], 4),
        }
        gates: dict[str, dict[str, Any]] = {}
        for name, rule in MVP_READINESS_THRESHOLDS.items():
            actual = actuals[name]
            threshold = float(rule["threshold"])
            operator = str(rule["operator"])
            passed = actual >= threshold if operator == ">=" else actual <= threshold
            gates[name] = {
                "actual": actual,
                "operator": operator,
                "threshold": threshold,
                "passed": passed,
            }

        coverage_failures = [
            failure for failure in failures if failure.get("metric") == "golden_case_coverage"
        ]
        gates["golden_case_coverage"] = {
            "actual": "complete" if not coverage_failures else "missing",
            "operator": "complete",
            "threshold": sorted(REQUIRED_GOLDEN_SCENARIOS),
            "passed": not coverage_failures,
        }
        return {
            "passed": all(gate["passed"] for gate in gates.values()),
            "gates": gates,
        }
