from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.application.dto import (
    EvidenceRef,
    GoalConstraint,
    GoalTarget,
    ProductRelation,
    ProductSemanticProfile,
    SemanticProfileMethod,
    ShoppingGoal,
)
from backend.application.services.rec import (
    adjudicate_profile,
    build_rule_profile,
    qualify_product,
)
from backend.application.services.rec.semantic import PROFILE_VERSION
from backend.domain.category_contracts import (
    CATEGORY_CONTRACTS,
    SemanticProfileMode,
    publishable_item_types,
    validate_category_contracts,
)
from backend.domain.models import NormalizedProduct


def product(title: str, *, url: str | None = None) -> NormalizedProduct:
    return NormalizedProduct(
        id="source-1",
        title=title,
        merchant="reviewed-merchant",
        url=url,
        native_price_amount=100,
        native_currency="USD",
        rmb_price=700,
    )


def test_runtime_flags_cannot_publish_an_offline_category() -> None:
    enabled = publishable_item_types(["smartphone", "headphones", "monitor", "unknown"])
    assert enabled == frozenset({"smartphone", "headphones"})
    assert CATEGORY_CONTRACTS["monitor"].lifecycle == "offline"
    assert CATEGORY_CONTRACTS["monitor"].semantic_profile_mode == SemanticProfileMode.RULE_ONLY
    assert CATEGORY_CONTRACTS["headphones"].semantic_profile_mode == SemanticProfileMode.SHADOW


def test_publishable_contract_profile_versions_cannot_drift() -> None:
    assert {
        contract.qualification_profile_version
        for contract in CATEGORY_CONTRACTS.values()
        if contract.is_publishable
    } == {PROFILE_VERSION}


def test_contract_gold_versions_match_the_reviewed_dataset() -> None:
    gold_path = Path(__file__).parent / "eval" / "qualification_gold.json"
    version = json.loads(gold_path.read_text(encoding="utf-8"))["schema_version"]
    assert {
        contract.gold_dataset_version for contract in CATEGORY_CONTRACTS.values()
    } == {version}


def test_publishable_contract_requires_runtime_detector() -> None:
    with pytest.raises(ValueError, match="semantic detector"):
        validate_category_contracts(
            qualification_profile_version=PROFILE_VERSION,
            detected_item_types=frozenset({"smartphone"}),
        )


def test_contract_forbids_accessory_relation_even_when_user_requests_it() -> None:
    goal = ShoppingGoal(
        target=GoalTarget(
            item_type="headphones",
            relation_required=ProductRelation.ACCESSORY,
        )
    )
    result = qualify_product(product("Sony Headphones Replacement Ear Pads"), goal)
    assert result.eligibility == "ineligible"
    assert any(
        item.reason_code == "relation_forbidden_by_contract"
        for item in result.assessments
    )


def test_contract_blocks_a_constraint_without_registered_evaluator() -> None:
    goal = ShoppingGoal(
        target=GoalTarget(item_type="headphones"),
        constraints=[
            GoalConstraint(
                constraint_id="hard:unsupported",
                facet="carbon_footprint",
                value="low",
            )
        ],
    )
    result = qualify_product(product("Sony Wireless Headphones"), goal)
    assert result.eligibility == "needs_evidence"
    assert any(
        item.reason_code == "constraint_not_supported_by_category"
        for item in result.assessments
    )


def test_rule_profile_is_evidence_bound_and_versioned() -> None:
    profile = build_rule_profile(product("Sony Wireless Noise Cancelling Headphones"))
    assert profile.category_id == "headphones"
    assert profile.item_type == "headphones"
    assert profile.relation == "product"
    assert profile.method == SemanticProfileMethod.RULE
    assert profile.evidence_refs
    assert profile.classifier_version == PROFILE_VERSION


def test_high_confidence_model_proposal_can_fill_an_unknown_guard() -> None:
    guard = build_rule_profile(product("Sony WH-1000XM5"))
    proposal = ProductSemanticProfile(
        category_id="headphones",
        item_type="headphones",
        relation="product",
        method=SemanticProfileMethod.MODEL,
        confidence=0.96,
        evidence_spans=["WH-1000XM5"],
        evidence_refs=[
            EvidenceRef(
                source="normalized",
                path="normalized.title",
                value="Sony WH-1000XM5",
            )
        ],
        classifier_version="semantic-model-v1",
    )
    decided = adjudicate_profile(guard, proposal)
    assert decided.item_type == "headphones"
    assert decided.relation == "product"
    assert decided.method == SemanticProfileMethod.ADJUDICATED
    assert decided.confidence == 0.96


def test_guard_model_disagreement_abstains_instead_of_promoting() -> None:
    guard = build_rule_profile(product("Apple iPhone 16 Smartphone"))
    proposal = ProductSemanticProfile(
        category_id="headphones",
        item_type="headphones",
        relation="product",
        method=SemanticProfileMethod.MODEL,
        confidence=0.99,
        evidence_spans=["iPhone 16"],
        evidence_refs=[
            EvidenceRef(
                source="normalized",
                path="normalized.title",
                value="Apple iPhone 16 Smartphone",
            )
        ],
        classifier_version="semantic-model-v1",
    )
    decided = adjudicate_profile(guard, proposal)
    assert decided.item_type is None
    assert decided.relation == "unknown"
    assert decided.confidence == 0
    assert "guard_model_item_type_conflict" in decided.conflict_reason_codes


def test_each_assessment_is_bound_to_the_goal_version() -> None:
    goal = ShoppingGoal(goal_version=7, target=GoalTarget(item_type="headphones"))
    result = qualify_product(product("Bose QuietComfort Headphones"), goal)
    assert result.assessments
    assert {item.goal_version for item in result.assessments} == {7}
