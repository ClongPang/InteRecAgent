from __future__ import annotations

from collections import Counter

from pydantic import BaseModel, Field


class ConversationObservation(BaseModel):
    user_id: str
    scenario_id: str
    expected_item_type: str | None = None
    goal: dict = Field(default_factory=dict)
    candidate_set: dict = Field(default_factory=dict)
    final_answer: dict = Field(default_factory=dict)
    clarification_required: bool = False
    clarification_expected: bool = False


class ConversationQualityReport(BaseModel):
    scenario_count: int
    user_count: int
    hard_constraint_violation_rate: float
    accessory_false_recommendation_rate: float
    unsupported_fact_rate: float
    obligation_coverage_rate: float
    goal_drift_rate: float
    unnecessary_clarification_rate: float
    failure_counts: dict[str, int] = Field(default_factory=dict)
    failed_scenarios: dict[str, list[str]] = Field(default_factory=dict)


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def evaluate_conversations(
    observations: list[ConversationObservation],
) -> ConversationQualityReport:
    failures: Counter[str] = Counter()
    failed_scenarios: dict[str, list[str]] = {}
    ranked_total = 0
    hard_violations = 0
    accessory_violations = 0
    factual_claims = 0
    unsupported_claims = 0
    obligations = 0
    answered_obligations = 0
    goal_checks = 0
    goal_drifts = 0
    unnecessary_clarifications = 0

    def fail(observation: ConversationObservation, code: str) -> None:
        failures[code] += 1
        failed_scenarios.setdefault(observation.scenario_id, []).append(code)

    for observation in observations:
        candidate_set = observation.candidate_set
        qualifications = {
            str(item.get("candidate_id")): item
            for item in candidate_set.get("qualifications", [])
        }
        for ranked in candidate_set.get("ranked", []):
            ranked_total += 1
            source_id = str(ranked.get("source_product_id") or "")
            qualification = qualifications.get(source_id)
            if qualification and qualification.get("eligibility") != "eligible":
                hard_violations += 1
                fail(observation, "hard_constraint_violation")
            relation = ((qualification or {}).get("profile") or {}).get("relation")
            if relation and relation != "product":
                accessory_violations += 1
                fail(observation, "non_product_recommended")

        final_answer = observation.final_answer
        ledger = final_answer.get("claim_ledger") or {}
        for claim in ledger.get("claims", []):
            if claim.get("wording_policy", "factual") == "factual":
                factual_claims += 1
                if not claim.get("evidence_refs"):
                    unsupported_claims += 1
                    fail(observation, "unsupported_factual_claim")
        plan = final_answer.get("answer_plan") or {}
        for obligation in plan.get("obligations", []):
            obligations += 1
            if obligation.get("status") in {"answered", "unknown"}:
                answered_obligations += 1
            else:
                fail(observation, "uncovered_obligation")

        if observation.expected_item_type:
            goal_checks += 1
            actual = ((observation.goal.get("target") or {}).get("item_type"))
            if actual != observation.expected_item_type:
                goal_drifts += 1
                fail(observation, "goal_drift")
        if observation.clarification_required and not observation.clarification_expected:
            unnecessary_clarifications += 1
            fail(observation, "unnecessary_clarification")

    return ConversationQualityReport(
        scenario_count=len(observations),
        user_count=len({item.user_id for item in observations}),
        hard_constraint_violation_rate=_ratio(hard_violations, ranked_total),
        accessory_false_recommendation_rate=_ratio(accessory_violations, ranked_total),
        unsupported_fact_rate=_ratio(unsupported_claims, factual_claims),
        obligation_coverage_rate=_ratio(answered_obligations, obligations),
        goal_drift_rate=_ratio(goal_drifts, goal_checks),
        unnecessary_clarification_rate=_ratio(
            unnecessary_clarifications, len(observations)
        ),
        failure_counts=dict(failures),
        failed_scenarios=failed_scenarios,
    )
