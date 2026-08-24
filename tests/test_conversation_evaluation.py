from __future__ import annotations

from backend.application.services.evaluation import (
    ConversationObservation,
    evaluate_conversations,
)


def observation(user: str, scenario: str) -> ConversationObservation:
    return ConversationObservation(
        user_id=user,
        scenario_id=scenario,
        expected_item_type="smartphone",
        goal={"target": {"item_type": "smartphone"}},
        candidate_set={
            "ranked": [{"source_product_id": "p1"}],
            "qualifications": [
                {
                    "candidate_id": "p1",
                    "eligibility": "eligible",
                    "profile": {"relation": "product"},
                }
            ],
        },
        final_answer={
            "answer_plan": {
                "obligations": [{"facet": "recommendation", "status": "answered"}]
            },
            "claim_ledger": {
                "claims": [
                    {
                        "wording_policy": "factual",
                        "evidence_refs": [{"source": "snapshot", "path": "title"}],
                    }
                ]
            },
        },
    )


def test_multi_user_quality_report_is_zero_defect_for_grounded_runs():
    report = evaluate_conversations(
        [observation("user-a", "iphone"), observation("user-b", "gift")]
    )
    assert report.user_count == 2
    assert report.scenario_count == 2
    assert report.hard_constraint_violation_rate == 0
    assert report.accessory_false_recommendation_rate == 0
    assert report.unsupported_fact_rate == 0
    assert report.obligation_coverage_rate == 1
    assert report.failure_counts == {}


def test_failures_are_classified_to_actionable_root_causes():
    broken = observation("user-c", "broken-accessory")
    broken.goal["target"]["item_type"] = "headphones"
    broken.candidate_set["qualifications"][0]["eligibility"] = "ineligible"
    broken.candidate_set["qualifications"][0]["profile"]["relation"] = "accessory"
    broken.final_answer["claim_ledger"]["claims"][0]["evidence_refs"] = []
    broken.final_answer["answer_plan"]["obligations"][0]["status"] = "needs_research"
    broken.clarification_required = True
    report = evaluate_conversations([broken])
    assert report.failure_counts == {
        "hard_constraint_violation": 1,
        "non_product_recommended": 1,
        "unsupported_factual_claim": 1,
        "uncovered_obligation": 1,
        "goal_drift": 1,
        "unnecessary_clarification": 1,
    }
