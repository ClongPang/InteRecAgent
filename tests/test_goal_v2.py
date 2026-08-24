from __future__ import annotations

import pytest

from backend.application.dto import (
    AssessmentVerdict,
    CandidateEligibility,
    GoalConstraint,
    GoalOperation,
    GoalOperationKind,
    GoalTarget,
    MissionConstraints,
    ProductRelation,
    RetrievalScope,
    ShoppingGoal,
    ShoppingMission,
)
from backend.application.dto.belief import PreferenceBelief, SoftPref, SpecGate
from backend.application.services.goal import (
    apply_goal_operations,
    compile_constraint_operations,
    compile_goal_operations,
    compile_preference_operations,
    compile_rejection_operations,
    constraint_view_from_goal,
    goal_from_constraint_view,
    validate_goal_operations,
)
from backend.application.services.parse_intent import (
    extract_query,
    parse_budget,
    parse_markets,
    sanitize_inferred_merchants,
)
from backend.application.services.rec import (
    assess_goal_coverage,
    eligible_candidate_markets,
    rec_state_from_mission,
)
from backend.application.services.rec.qualify import profile_product, qualify_product
from backend.domain.models import NormalizedProduct
from backend.domain.product_ontology import DETECTED_ITEM_TYPES, SUPPORTED_ITEM_TYPES
from backend.infrastructure.persistence.repositories import _canonical_goal


def product(
    title: str,
    *,
    price: float | None = 1000,
    stock=None,
    stock_source=None,
    attrs: dict[str, str] | None = None,
):
    return NormalizedProduct(
        id=title[:12],
        title=title,
        merchant="merchant",
        native_price_amount=100,
        native_currency="USD",
        rmb_price=price,
        in_stock=stock,
        stock_source=stock_source,
        attrs=attrs or {},
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("under CNY 2500", 2500),
        ("My budget was CNY 6000", 6000),
        ("maximum budget is RMB 1000", 1000),
        ("预算 2,500 元以内", 2500),
    ],
)
def test_budget_formats(text, expected):
    assert parse_budget(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "iPhone 1600 Pro",
        "Sony WH 1000 XM5",
        "Bose QuietComfort 700 headphones",
        "Samsung Galaxy S25 smartphone",
    ],
)
def test_product_model_numbers_are_not_budgets(text):
    assert parse_budget(text) is None


def test_market_codes_do_not_match_english_pronouns():
    assert parse_markets("a gift for my mother") is None
    assert parse_markets("raise my maximum budget") is None
    assert parse_markets("search US or Singapore, not Malaysia") == ["US", "SG"]


def test_market_phrases_cannot_become_model_inferred_merchants():
    assert sanitize_inferred_merchants(["美国和新加坡", "only US and Singapore"]) == []
    assert sanitize_inferred_merchants(["Amazon US"]) == ["Amazon US"]


def test_market_qualifier_is_removed_as_one_query_slot():
    assert extract_query("iPhone 16，预算 8000 元，只看美国") == "iPhone 16"
    assert extract_query("通勤降噪耳机，预算 4000 元，只看美国和新加坡") == "通勤降噪耳机"
    assert extract_query("iPhone 16 under CNY 8000, US only") == "iPhone 16"
    assert extract_query("headphones, only US and Singapore") == "headphones"


def test_compiler_preserves_multiple_operations_in_one_turn():
    ops = compile_goal_operations(
        "Only actual Apple iPhone smartphones under CNY 8000 in US, not cases or kits.",
        goal_version=3,
        source_turn_id="turn-1",
    )
    kinds = [item.kind for item in ops]
    assert GoalOperationKind.SET_TARGET in kinds
    assert GoalOperationKind.UPSERT_CONSTRAINT in kinds
    assert GoalOperationKind.SET_RETRIEVAL_SCOPE in kinds
    assert kinds[-1] == GoalOperationKind.REQUEST_RESEARCH
    goal = apply_goal_operations(ShoppingGoal(goal_version=3), ops)
    assert goal.goal_version == 4
    assert goal.target.item_type == "smartphone"
    assert goal.target.brand == "Apple"
    assert goal.retrieval_scope.markets_requested == ["US"]
    assert goal.active_constraint("budget").value == 8000
    assert goal.active_constraint("relation").value == "product"


def test_compiler_canonicalizes_exact_iphone_target_from_full_request():
    ops = compile_goal_operations(
        "帮我找一台 Apple iPhone 15 Pro 手机，商品价预算 9000 元以内；比较美国和新加坡市场",
        goal_version=1,
    )
    goal = apply_goal_operations(ShoppingGoal(), ops)
    assert goal.target.item_type == "smartphone"
    assert goal.target.brand == "Apple"
    assert goal.target.model == "iPhone 15 Pro"
    assert goal.target.canonical_description == "Apple iPhone 15 Pro"


def test_compiler_is_replay_stable_and_reducer_is_idempotent():
    text = "Sony headphones under CNY 2500 on Amazon in US"
    first = compile_goal_operations(text, goal_version=1, source_turn_id="turn-stable")
    replay = compile_goal_operations(text, goal_version=1, source_turn_id="turn-stable")
    assert [item.op_id for item in first] == [item.op_id for item in replay]
    goal = apply_goal_operations(ShoppingGoal(), first)
    same_semantics = compile_goal_operations(
        text, goal_version=goal.goal_version, source_turn_id="turn-2"
    )
    unchanged = apply_goal_operations(goal, same_semantics)
    assert unchanged == goal
    assert goal.target.brand == "Sony"
    assert goal.retrieval_scope.platforms == ["amazon"]


def test_reducer_rejects_stale_operations():
    ops = compile_goal_operations("iPhone under CNY 8000", goal_version=1)
    with pytest.raises(ValueError, match="goal version conflict"):
        apply_goal_operations(ShoppingGoal(goal_version=2), ops)


@pytest.mark.parametrize(
    ("title", "eligibility"),
    [
        ("Apple iPhone 16 Pro Max 256GB", CandidateEligibility.ELIGIBLE),
        ("Stroller Kits - iPhone", CandidateEligibility.INELIGIBLE),
        ("Ponchos - iPhone", CandidateEligibility.NEEDS_EVIDENCE),
        ("Apple iPhone 16 Pro Silicone Case", CandidateEligibility.INELIGIBLE),
    ],
)
def test_smartphone_identity_gate(title, eligibility):
    goal = ShoppingGoal(
        target=GoalTarget(
            item_type="smartphone",
            brand="Apple",
            relation_required=ProductRelation.PRODUCT,
        )
    )
    result = qualify_product(product(title), goal)
    assert result.eligibility == eligibility


def test_headphone_accessory_does_not_enter_feasible_set():
    goal = ShoppingGoal(target=GoalTarget(item_type="headphones"))
    result = qualify_product(product("Replacement Ear Pads for Sony Headphones"), goal)
    assert result.profile.relation == "replacement"
    assert result.eligibility == CandidateEligibility.INELIGIBLE


def test_listing_title_and_destination_url_identity_conflict_is_blocked():
    goal = ShoppingGoal(target=GoalTarget(item_type="headphones"))
    conflicting = NormalizedProduct(
        id="provider-conflict",
        title="Noise Cancelling Headphones",
        merchant="merchant",
        url=(
            "https://merchant.example/products/"
            "3v-to-12v-universal-power-supply-adapter-multiple-dc-tips"
        ),
        native_price_amount=30,
        native_currency="USD",
        rmb_price=200,
    )
    result = qualify_product(conflicting, goal)
    relation = next(
        item for item in result.assessments if item.constraint_id == "system:target_relation"
    )
    assert result.profile.relation == "unknown"
    assert relation.verdict == AssessmentVerdict.UNKNOWN
    assert result.eligibility == CandidateEligibility.NEEDS_EVIDENCE
    assert any(ref.path == "url.path" for ref in result.profile.evidence_refs)


def test_unknown_stock_never_becomes_satisfied():
    from backend.application.dto import GoalConstraint, UnknownPolicy

    goal = ShoppingGoal(
        target=GoalTarget(item_type="headphones"),
        constraints=[
            GoalConstraint(
                constraint_id="stock",
                facet="stock",
                value=True,
                evidence_threshold="provider_top_level",
                unknown_policy=UnknownPolicy.BLOCK,
            )
        ],
    )
    result = qualify_product(product("Sony Noise Cancelling Headphones"), goal)
    stock = next(item for item in result.assessments if item.constraint_id == "stock")
    assert stock.verdict == AssessmentVerdict.UNKNOWN
    assert result.eligibility == CandidateEligibility.NEEDS_EVIDENCE


def test_literal_exclusion_constraint_is_evaluated_instead_of_blocking_every_candidate():
    goal = ShoppingGoal(
        target=GoalTarget(item_type="headphones"),
        constraints=[
            GoalConstraint(
                constraint_id="exclude-mic-only",
                facet="exclude_term:只有麦克风降噪",
                operator="not_contains",
                value="只有麦克风降噪",
                unknown_policy="block",
            )
        ],
    )
    allowed = qualify_product(
        product("Sennheiser Momentum 4 Over-Ear Headphones with ANC"), goal
    )
    blocked = qualify_product(product("只有麦克风降噪 Headphones"), goal)

    assert allowed.eligibility == CandidateEligibility.ELIGIBLE
    assert next(
        item for item in allowed.assessments if item.constraint_id == "exclude-mic-only"
    ).reason_code == "excluded_term_absent"
    assert blocked.eligibility == CandidateEligibility.INELIGIBLE


def test_stock_requirement_is_compiled_as_blocking_goal_constraint():
    operations = compile_goal_operations(
        "iPhone 15 Pro，只看有货",
        goal_version=1,
        source_turn_id="stock-turn",
    )
    goal = apply_goal_operations(ShoppingGoal(), operations)
    stock = goal.active_constraint("stock")
    assert stock is not None
    assert stock.value is True
    assert stock.unknown_policy.value == "block"
    assert stock.evidence_threshold == "provider_top_level"


def test_metadata_stock_is_too_weak_for_confirmed_stock():
    from backend.application.dto import GoalConstraint

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
    item = product("Sony Noise Cancelling Headphones", stock=True, stock_source="metadata")
    result = qualify_product(item, goal)
    stock = next(row for row in result.assessments if row.constraint_id == "stock")
    assert stock.verdict == AssessmentVerdict.UNKNOWN


def test_profile_does_not_infer_phone_from_keyword_alone():
    profile = profile_product(product("Ponchos - iPhone"))
    assert profile.item_type is None
    assert profile.relation == "unknown"


def test_coverage_distinguishes_empty_from_blocked_on_evidence():
    goal = ShoppingGoal(target=GoalTarget(item_type="smartphone", brand="Apple"))
    eligible = qualify_product(product("Apple iPhone 16 Pro"), goal)
    unknown = qualify_product(product("Ponchos - iPhone"), goal)
    sufficient = assess_goal_coverage([eligible, unknown], goal_version=4)
    blocked = assess_goal_coverage([unknown], goal_version=4)
    empty = assess_goal_coverage([], goal_version=4)
    assert sufficient.status == "sufficient"
    assert blocked.status == "blocked_on_evidence"
    assert "item_type_unknown" in blocked.blocking_reason_codes
    assert empty.status == "insufficient"


def test_goal_compiler_persists_explicit_ranking_preference():
    ops = compile_goal_operations("通勤降噪耳机，预算 4000 元，优先续航", goal_version=1)
    goal = apply_goal_operations(ShoppingGoal(), ops)
    assert goal.preferences[-1].facet == "ranking_preference"
    assert goal.preferences[-1].value == "battery"


def test_research_reads_goal_when_legacy_constraints_disagree():
    mission = ShoppingMission(
        owner_id="goal-authority",
        title="authority",
        constraints=MissionConstraints(
            query="stale query",
            budget_cny=9999,
            markets=["SG"],
            preference="lowest",
        ),
        goal=ShoppingGoal(
            target=GoalTarget(
                item_type="headphones",
                canonical_description="canonical headphones",
            ),
            constraints=[
                GoalConstraint(
                    constraint_id="budget",
                    facet="budget",
                    operator="lte",
                    value=1200,
                    unit="CNY",
                )
            ],
            preferences=[
                GoalConstraint(
                    constraint_id="preference",
                    facet="ranking_preference",
                    value="battery",
                    hardness="soft",
                    unknown_policy="allow",
                )
            ],
            retrieval_scope=RetrievalScope(markets_requested=["US"]),
        ),
    )
    rec = rec_state_from_mission(mission)
    assert rec.query == "canonical headphones"
    assert rec.budget_cny == 1200
    assert rec.markets == ("US",)
    assert rec.preference == "battery"


def test_open_preferences_and_required_spec_gates_are_committed_to_goal():
    operations = compile_preference_operations(
        goal_version=1,
        source_turn_id="turn-preferences",
        use_case="远程办公",
        soft_prefs=[SoftPref(attr="comfort", cues=["comfortable"])],
        spec_gates=[SpecGate(attr="4k", cues=["4k", "uhd"], required=True)],
    )
    goal = apply_goal_operations(ShoppingGoal(), operations)
    assert any(item.facet == "use_case" for item in goal.preferences)
    assert any(item.facet == "soft_preference:comfort" for item in goal.preferences)
    assert goal.active_constraint("spec_gate:4k") is not None


def test_duplicate_model_anc_facets_compile_to_one_canonical_constraint():
    operations = compile_preference_operations(
        goal_version=1,
        origin="model",
        spec_gates=[
            SpecGate(attr="anc", cues=[], required=True),
            SpecGate(
                attr="noise_reduction_type",
                cues=["ANC", "主动降噪"],
                required=True,
            ),
        ],
    )

    assert len(operations) == 1
    assert operations[0].payload["facet"] == "spec_gate:noise_cancelling"


def test_coverage_requires_every_explicitly_requested_market():
    goal = ShoppingGoal(target=GoalTarget(item_type="headphones"))
    eligible = qualify_product(product("Sony Noise Cancelling Headphones"), goal)
    partial = assess_goal_coverage(
        [eligible],
        goal_version=2,
        requested_markets=["US", "SG"],
        eligible_markets=["US"],
    )
    assert partial.status == "insufficient"
    assert partial.covered_markets == ["US"]
    assert partial.missing_markets == ["SG"]
    assert "requested_market_uncovered:SG" in partial.blocking_reason_codes


def test_iphone_lens_protector_never_enters_feasible_set():
    goal = ShoppingGoal(
        target=GoalTarget(
            item_type="smartphone",
            brand="Apple",
            relation_required="product",
        )
    )
    result = qualify_product(product("iPhone 16 Pro Camera Lens Protector"), goal)
    assert result.eligibility == "ineligible"
    relation = next(
        item for item in result.assessments if item.constraint_id == "system:target_relation"
    )
    assert relation.reason_code == "relation_mismatch"


def test_iphone_tempered_glass_never_enters_feasible_set():
    goal = ShoppingGoal(
        target=GoalTarget(item_type="smartphone", brand="Apple", relation_required="product")
    )
    result = qualify_product(
        product("Premium Tempered Glass - Apple iPhone 15 Pro"), goal
    )
    assert result.profile.relation == "accessory"
    assert result.eligibility == "ineligible"


@pytest.mark.parametrize(
    "title",
    [
        "Presidio2 Pro iPhone 15 Pro Max Cases",
        "Protective Covers for Apple iPhone 15 Pro",
    ],
)
def test_plural_phone_accessories_never_enter_feasible_set(title):
    goal = ShoppingGoal(
        target=GoalTarget(item_type="smartphone", brand="Apple", relation_required="product")
    )
    result = qualify_product(product(title), goal)
    assert result.profile.relation == "accessory"
    assert result.eligibility == "ineligible"


def test_phone_compatible_keyboard_never_enters_smartphone_feasible_set():
    goal = ShoppingGoal(
        target=GoalTarget(item_type="smartphone", brand="Apple", relation_required="product")
    )
    result = qualify_product(
        product("Bluetooth Keyboard for Apple iPhone Smartphone and Tablet"), goal
    )
    assert result.profile.relation == "accessory"
    assert result.eligibility == "ineligible"


def test_tool_hearing_protection_never_enters_headphones_feasible_set():
    goal = ShoppingGoal(target=GoalTarget(item_type="headphones"))
    item = product(
        "Audio Plus Noise Suppression Headphones",
        attrs={"tags": "article_type:Hand Tools & E-Tools"},
    )
    result = qualify_product(item, goal)
    assert result.profile.item_type == "hearing_protection"
    assert result.eligibility == "ineligible"


@pytest.mark.parametrize(
    ("text", "item_type"),
    [
        ("MacBook Air M4 laptop", "laptop"),
        ("27 inch 4K gaming monitor", "monitor"),
        ("Sony Alpha mirrorless camera", "camera"),
        ("Salomon hiking shoes", "footwear"),
        ("cordless vacuum cleaner", "appliance"),
    ],
)
def test_goal_compiler_uses_shared_multi_category_ontology(text, item_type):
    ops = compile_goal_operations(text, goal_version=1)
    goal = apply_goal_operations(ShoppingGoal(), ops)
    assert goal.target.item_type == item_type
    assert item_type in DETECTED_ITEM_TYPES
    if item_type == "monitor":
        # Recognition and offline evaluation do not grant online release authority.
        assert item_type not in SUPPORTED_ITEM_TYPES
    else:
        assert item_type not in SUPPORTED_ITEM_TYPES


@pytest.mark.parametrize(
    ("title", "relation"),
    [
        ("Protection Plan for MacBook", "service"),
        ("Replacement Ear Pads for Headphones", "replacement"),
        ("USB-C Charger for Laptop", "accessory"),
        ("iPhone 16 Pro Camera Lens Protector", "accessory"),
        ("iPhone 16 Pro Camera Lens Tempered Glass Screen Protectors", "accessory"),
        ("Camera Accessory Kit", "bundle"),
        ("Replacement Filters for Vacuum Cleaner", "consumable"),
    ],
)
def test_relation_ontology_blocks_non_product_relations(title, relation):
    profile = profile_product(product(title))
    assert profile.relation == relation


def test_buywhere_metadata_can_supply_item_type_evidence():
    item = product(
        "WH1000XM5 Black",
        attrs={"category": "Audio Headphones", "vendor": "Sony"},
    )
    result = qualify_product(item, ShoppingGoal(target=GoalTarget(item_type="headphones")))
    assert result.eligibility == CandidateEligibility.ELIGIBLE
    assert result.profile.brand == "Sony"
    assert any(ref.path == "metadata.category" for ref in result.profile.evidence_refs)


def test_laptop_accessory_cannot_enter_laptop_feasible_set():
    goal = ShoppingGoal(target=GoalTarget(item_type="laptop"))
    result = qualify_product(product("Protective Sleeve for MacBook Pro Laptop"), goal)
    assert result.profile.item_type == "laptop"
    assert result.profile.relation == "accessory"
    assert result.eligibility == CandidateEligibility.INELIGIBLE


def test_goal_is_authority_and_legacy_constraints_are_lossless_projection():
    legacy = MissionConstraints(
        query="laptop",
        budget_cny=6000,
        markets=["SG"],
        preference="balanced",
        only_in_stock=True,
        excluded_terms=["case"],
        merchants=["amazon"],
    )
    goal = goal_from_constraint_view(legacy, version=2)
    assert constraint_view_from_goal(goal) == legacy
    changed = goal_from_constraint_view(
        legacy.model_copy(update={"budget_cny": 5000}),
        version=3,
        current=goal,
    )
    budgets = [item for item in changed.constraints if item.facet == "budget"]
    assert [item.status for item in budgets] == ["retracted", "active"]
    assert constraint_view_from_goal(changed).budget_cny == 5000


def test_excluded_terms_are_retractable_constraints_not_candidate_ids():
    before = MissionConstraints(query="headphones", excluded_terms=["earbuds"])
    goal = goal_from_constraint_view(before, version=2)
    assert goal.rejected_entities == []
    assert constraint_view_from_goal(goal).excluded_terms == ["earbuds"]

    operations = compile_constraint_operations(
        before,
        before.model_copy(update={"excluded_terms": []}),
        goal=goal,
    )
    updated = apply_goal_operations(goal, operations)
    assert constraint_view_from_goal(updated).excluded_terms == []


def test_constraint_compiler_atomizes_model_compound_exclusions():
    before = MissionConstraints(query="iPhone 15 Pro")
    goal = goal_from_constraint_view(before, version=1)
    after = before.model_copy(
        update={
            "excluded_terms": [
                "手机壳",
                "充电器",
                "保护膜",
                "手机壳、充电器或保护膜",
            ]
        }
    )
    operations = compile_constraint_operations(before, after, goal=goal, origin="model")
    updated = apply_goal_operations(goal, operations)
    assert constraint_view_from_goal(updated).excluded_terms == ["手机壳", "充电器", "保护膜"]


def test_candidate_and_listing_rejections_are_goal_authoritative():
    goal = goal_from_constraint_view(MissionConstraints(query="headphones"), version=2).model_copy(
        update={"legacy_belief_migrated": True}
    )
    operations = compile_rejection_operations(
        goal=goal,
        snapshot_ids=["snap-goal"],
        listing_keys=["src:goal"],
    )
    goal = apply_goal_operations(goal, operations)
    mission = ShoppingMission(
        owner_id="u1",
        title="goal rejection authority",
        constraints=MissionConstraints(query="stale laptop"),
        goal=goal,
        belief=PreferenceBelief(
            rejected_snapshot_ids=["snap-stale"],
            rejected_listing_keys=["src:stale"],
        ),
    )
    rec = rec_state_from_mission(mission)
    assert rec.rejected_snapshot_ids == {"snap-goal"}
    assert rec.rejected_listing_keys == {"src:goal"}


def test_coverage_market_resolution_accepts_persisted_snapshot_ids():
    item = product("27 inch 4K monitor").model_copy(update={"country_code": "SG"})
    qualification = qualify_product(
        item,
        ShoppingGoal(target=GoalTarget(item_type="monitor")),
    ).model_copy(update={"candidate_id": "snapshot-1"})
    assert eligible_candidate_markets(
        [item], [qualification], snapshot_map={item.id: "snapshot-1"}
    ) == ["SG"]


def _op(op_id: str, value: float, *, origin: str) -> GoalOperation:
    return GoalOperation(
        op_id=op_id,
        kind=GoalOperationKind.UPSERT_CONSTRAINT,
        payload={"facet": "budget", "operator": "lte", "value": value},
        origin=origin,
        precondition_goal_version=1,
    )


def test_goal_validator_prefers_deterministic_value_over_model_value():
    result = validate_goal_operations(
        ShoppingGoal(),
        [_op("model", 6000, origin="model"), _op("parser", 5000, origin="deterministic")],
    )
    assert not result.conflicts
    assert len(result.operations) == 1
    assert result.operations[0].payload["value"] == 5000


@pytest.mark.parametrize(
    ("text", "expected_facets"),
    [
        ("通勤降噪耳机，优先续航", {"spec_gate:noise_cancelling"}),
        ("27 英寸 4K 显示器", {"spec_gate:4k", "spec_gate:screen_size"}),
    ],
)
def test_explicit_product_specs_compile_to_hard_goal_gates(text, expected_facets):
    operations = compile_goal_operations(text, goal_version=1)
    facets = {
        item.payload.get("facet")
        for item in operations
        if item.kind == GoalOperationKind.UPSERT_CONSTRAINT
    }
    assert expected_facets <= facets
    for operation in operations:
        if operation.payload.get("facet") in expected_facets:
            assert operation.payload["hardness"] == "hard"
            assert operation.payload["unknown_policy"] == "block"


def test_goal_validator_rejects_same_authority_conflict_atomically():
    result = validate_goal_operations(
        ShoppingGoal(),
        [_op("one", 6000, origin="model"), _op("two", 5000, origin="model")],
    )
    assert result.requires_clarification
    assert result.operations == []
    assert result.conflicts[0].code == "conflicting_operations"


def test_repository_projection_never_overwrites_existing_goal():
    authoritative = goal_from_constraint_view(
        MissionConstraints(query="headphones", budget_cny=3000), version=4
    ).model_copy(update={"legacy_belief_migrated": True})
    mission = ShoppingMission(
        owner_id="u1",
        title="goal authority",
        constraints_version=4,
        constraints=MissionConstraints(query="stale laptop", budget_cny=9000),
        goal=authoritative,
    )
    goal, projection = _canonical_goal(mission)
    assert goal == authoritative
    assert projection.query == "headphones"
    assert projection.budget_cny == 3000
