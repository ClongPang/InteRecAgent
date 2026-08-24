from __future__ import annotations

import json
from pathlib import Path

from backend.application.dto import GoalTarget, ShoppingGoal
from backend.application.services.rec.qualify import qualify_product
from backend.domain.models import NormalizedProduct

GOLD = Path(__file__).with_name("qualification_gold.json")


def test_released_category_qualification_gold_meets_release_gates() -> None:
    payload = json.loads(GOLD.read_text(encoding="utf-8"))
    predictions: list[tuple[str, str]] = []
    for case in payload["cases"]:
        product = NormalizedProduct(
            id=case["id"],
            title=case["title"],
            merchant="reviewed-merchant",
            native_price_amount=100,
            native_currency="USD",
            rmb_price=700,
            attrs=case.get("attrs") or {},
        )
        result = qualify_product(
            product,
            ShoppingGoal(target=GoalTarget(item_type=case["target"])),
        )
        predictions.append((case["expected"], result.eligibility.value))
        assert all(assessment.evaluator_version for assessment in result.assessments)
        assert all(
            assessment.evidence_refs
            for assessment in result.assessments
            if assessment.verdict.value != "unknown"
        )

    predicted_eligible = [pair for pair in predictions if pair[1] == "eligible"]
    true_eligible = [pair for pair in predictions if pair[0] == "eligible"]
    true_positive = sum(expected == predicted == "eligible" for expected, predicted in predictions)
    precision = true_positive / len(predicted_eligible)
    recall = true_positive / len(true_eligible)
    wrong_type_or_accessory_eligible = sum(
        expected == "ineligible" and predicted == "eligible"
        for expected, predicted in predictions
    )
    unknown_promoted = sum(
        expected == "needs_evidence" and predicted == "eligible"
        for expected, predicted in predictions
    )

    assert precision >= 0.99
    assert recall >= 0.90
    assert wrong_type_or_accessory_eligible == 0
    assert unknown_promoted == 0
