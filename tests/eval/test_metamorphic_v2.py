"""Architecture metamorphic properties from the V2 verification matrix."""
from __future__ import annotations

import random

from backend.application.dto import (
    AssessmentVerdict,
    GoalConstraint,
    GoalTarget,
    MissionConstraints,
    ShoppingGoal,
    ShoppingMission,
)
from backend.application.services.goal import apply_goal_operations, compile_goal_operations
from backend.application.services.parse_intent import parse_budget, parse_markets
from backend.application.services.rec import run_filter, run_rank
from backend.application.services.rec.qualify import qualify_product
from backend.domain.models import NormalizedProduct


def _product(product_id: str, title: str, price: float | None) -> NormalizedProduct:
    return NormalizedProduct(
        id=product_id,
        title=title,
        native_price_amount=100,
        native_currency="USD",
        rmb_price=price,
    )


def _budget_goal(amount: float) -> ShoppingGoal:
    return ShoppingGoal(
        target=GoalTarget(item_type="headphones"),
        constraints=[
            GoalConstraint(
                constraint_id=f"budget-{amount}",
                facet="budget",
                operator="lte",
                value=amount,
                unit="CNY",
            )
        ],
    )


def test_budget_tightening_cannot_increase_feasible_set() -> None:
    products = [
        _product("low", "Wireless Headphones", 800),
        _product("mid", "Noise Cancelling Headphones", 1800),
        _product("high", "Studio Headphones", 2800),
        _product("unknown", "Travel Headphones", None),
    ]
    loose = {
        item.id
        for item in products
        if qualify_product(item, _budget_goal(3000)).eligibility == "eligible"
    }
    tight = {
        item.id
        for item in products
        if qualify_product(item, _budget_goal(1500)).eligibility == "eligible"
    }

    assert tight <= loose


def test_adding_hard_constraint_cannot_promote_candidate() -> None:
    candidate = _product("h", "Wireless Headphones", 900)
    base = ShoppingGoal(target=GoalTarget(item_type="headphones"))
    stock_required = base.model_copy(
        update={
            "constraints": [
                GoalConstraint(
                    constraint_id="stock",
                    facet="stock",
                    value=True,
                    evidence_threshold="provider_top_level",
                )
            ]
        }
    )

    assert qualify_product(candidate, base).eligibility == "eligible"
    assert qualify_product(candidate, stock_required).eligibility == "needs_evidence"


def test_lower_evidence_level_cannot_turn_unknown_into_satisfied() -> None:
    goal = ShoppingGoal(
        target=GoalTarget(item_type="headphones"),
        constraints=[
            GoalConstraint(
                constraint_id="stock",
                facet="stock",
                value=True,
                evidence_threshold="provider_top_level",
            )
        ],
    )
    weak = _product("weak", "Wireless Headphones", 900).model_copy(
        update={"in_stock": True, "stock_source": "metadata"}
    )
    assessment = next(
        item
        for item in qualify_product(weak, goal).assessments
        if item.constraint_id == "stock"
    )

    assert assessment.verdict == AssessmentVerdict.UNKNOWN


def test_ranking_preference_cannot_admit_ineligible_candidate() -> None:
    valid = _product("valid", "Wireless Headphones", 900)
    accessory = _product("pads", "Replacement Ear Pads for Headphones", 100)
    goal = ShoppingGoal(
        legacy_belief_migrated=True,
        target=GoalTarget(
            item_type="headphones",
            canonical_description="headphones",
        ),
    )
    mission = ShoppingMission(
        owner_id="metamorphic",
        title="rank gate",
        goal=goal,
        constraints=MissionConstraints(query="headphones", preference="lowest"),
    )
    feasible, _ = run_filter(
        mission.constraints,
        [accessory, valid],
        goal=goal,
        enabled_item_types=frozenset({"headphones"}),
    )
    ranked, _ = run_rank(mission, feasible)

    assert [item.id for item in ranked] == ["valid"]


def test_synonym_order_case_and_language_keep_same_goal() -> None:
    variants = [
        "US Sony headphones under CNY 2500",
        "CNY 2500, SONY HEADPHONES, US",
        "索尼耳机，预算 CNY 2500，只看美国",
    ]
    goals = [
        apply_goal_operations(ShoppingGoal(), compile_goal_operations(text, goal_version=1))
        for text in variants
    ]

    assert {
        (
            goal.target.item_type,
            goal.target.brand,
            goal.active_constraint("budget").value,
            tuple(goal.retrieval_scope.markets_requested),
        )
        for goal in goals
    } == {("headphones", "Sony", 2500.0, ("US",))}


def test_amount_currency_unit_and_market_token_fuzz() -> None:
    rng = random.Random(20260823)
    for _ in range(100):
        amount = rng.randint(100, 50_000)
        templates = [
            f"under CNY {amount}",
            f"RMB {amount} maximum",
            f"预算 {amount} 元以内",
        ]
        assert all(parse_budget(text) == amount for text in templates)

    for code in ("US", "SG", "VN", "TH", "MY"):
        assert parse_markets(f"search {code} only") == [code]
    for pronoun in ("my", "My", "mY"):
        assert parse_markets(f"a gift for {pronoun} mother") is None
