from __future__ import annotations

import re

from ....domain.category_contracts import CategoryContract, category_contract
from ....domain.models import NormalizedProduct
from ....domain.policies.text_match import text_matches_spec_cues
from ...dto.goal import GoalConstraint, ShoppingGoal, UnknownPolicy
from ...dto.qualification import (
    AssessmentVerdict,
    CandidateEligibility,
    CandidateQualification,
    ConstraintAssessment,
    EvidenceRef,
    ProductSemanticProfile,
)
from .semantic import profile_product

_SCREEN_SIZE = re.compile(
    r"(?<!\d)(\d{2,3})\s*(?:[- ]?inch(?:es)?|英寸|寸|\")",
    re.IGNORECASE,
)
_LOWER_THAN_4K = re.compile(
    r"\bfhd\b|\b1080p?\b|(?<!\d)1920\s*[x×*]\s*1080(?!\d)",
    re.IGNORECASE,
)


def _spec_evidence_conflicts(attr: str, observed: str, cues: list[str]) -> bool:
    """Return true when one evidence field contains mutually exclusive variants.

    Provider titles frequently concatenate variant SEO text. Independent cue
    hits must not compose a synthetic specification that no single variant is
    known to have.
    """
    if attr == "4k":
        return _LOWER_THAN_4K.search(observed) is not None
    if attr == "screen_size":
        expected = {match.group(1) for cue in cues for match in _SCREEN_SIZE.finditer(cue)}
        actual = {match.group(1) for match in _SCREEN_SIZE.finditer(observed)}
        return bool(expected & actual and actual - expected)
    return False


def _assessment(
    constraint: GoalConstraint,
    verdict: AssessmentVerdict,
    reason: str,
    *refs: EvidenceRef,
) -> ConstraintAssessment:
    return ConstraintAssessment(
        constraint_id=constraint.constraint_id,
        verdict=verdict,
        reason_code=reason,
        evidence_refs=list(refs),
    )


def _assess_constraint(
    product: NormalizedProduct,
    profile: ProductSemanticProfile,
    constraint: GoalConstraint,
) -> ConstraintAssessment:
    facet = constraint.facet
    if facet == "allowed_relation":
        allowed = {str(item) for item in constraint.value}
        if profile.relation == "unknown":
            verdict, reason = AssessmentVerdict.UNKNOWN, "relation_unknown"
        elif profile.relation in allowed:
            verdict, reason = AssessmentVerdict.SATISFIED, "relation_allowed_by_contract"
        else:
            verdict, reason = AssessmentVerdict.VIOLATED, "relation_forbidden_by_contract"
        return _assessment(constraint, verdict, reason, *profile.evidence_refs)
    if facet == "item_type":
        if profile.item_type is None:
            verdict, reason = AssessmentVerdict.UNKNOWN, "item_type_unknown"
        elif profile.item_type == str(constraint.value):
            verdict, reason = AssessmentVerdict.SATISFIED, "item_type_match"
        else:
            verdict, reason = AssessmentVerdict.VIOLATED, "item_type_mismatch"
        return _assessment(constraint, verdict, reason, *profile.evidence_refs)
    if facet == "relation":
        if profile.relation == "unknown":
            verdict, reason = AssessmentVerdict.UNKNOWN, "relation_unknown"
        elif profile.relation == str(constraint.value):
            verdict, reason = AssessmentVerdict.SATISFIED, "relation_match"
        else:
            verdict, reason = AssessmentVerdict.VIOLATED, "relation_mismatch"
        return _assessment(constraint, verdict, reason, *profile.evidence_refs)
    if facet == "budget":
        if product.rmb_price is None or product.fx_failed:
            return _assessment(constraint, AssessmentVerdict.UNKNOWN, "price_cny_unknown")
        limit = float(constraint.value)
        verdict = (
            AssessmentVerdict.SATISFIED
            if product.rmb_price <= limit
            else AssessmentVerdict.VIOLATED
        )
        return _assessment(
            constraint,
            verdict,
            "within_budget" if verdict == AssessmentVerdict.SATISFIED else "over_budget",
            EvidenceRef(source="normalized", path="rmb_price", value=product.rmb_price),
        )
    if facet == "brand":
        if not profile.brand:
            return _assessment(constraint, AssessmentVerdict.UNKNOWN, "brand_unknown")
        verdict = (
            AssessmentVerdict.SATISFIED
            if profile.brand.casefold() == str(constraint.value).casefold()
            else AssessmentVerdict.VIOLATED
        )
        return _assessment(
            constraint,
            verdict,
            "brand_match" if verdict == AssessmentVerdict.SATISFIED else "brand_mismatch",
            EvidenceRef(source="normalized", path="attrs.brand", value=profile.brand),
        )
    if facet == "stock":
        if product.in_stock is None:
            return _assessment(constraint, AssessmentVerdict.UNKNOWN, "stock_unknown")
        if product.in_stock is False:
            return _assessment(constraint, AssessmentVerdict.VIOLATED, "out_of_stock")
        if (
            constraint.evidence_threshold == "provider_top_level"
            and product.stock_source != "top_level"
        ):
            return _assessment(
                constraint, AssessmentVerdict.UNKNOWN, "stock_evidence_too_weak"
            )
        return _assessment(
            constraint,
            AssessmentVerdict.SATISFIED,
            "in_stock_observed",
            EvidenceRef(
                source="buywhere",
                path="availability.in_stock",
                value=True,
                evidence_level=product.stock_source or "unknown",
            ),
        )
    if facet.startswith("exclude_term:") and constraint.operator == "not_contains":
        expected = str(constraint.value or facet.split(":", 1)[-1]).strip()
        observed = product.title or ""
        if not expected or not observed:
            return _assessment(
                constraint, AssessmentVerdict.UNKNOWN, "exclude_term_unverifiable"
            )
        verdict = (
            AssessmentVerdict.VIOLATED
            if expected.casefold() in observed.casefold()
            else AssessmentVerdict.SATISFIED
        )
        return _assessment(
            constraint,
            verdict,
            (
                "excluded_term_present"
                if verdict == AssessmentVerdict.VIOLATED
                else "excluded_term_absent"
            ),
            EvidenceRef(source="normalized", path="title", value=observed),
        )
    if facet.startswith("spec_gate:"):
        value = constraint.value if isinstance(constraint.value, dict) else {}
        attr = str(value.get("attr") or facet.split(":", 1)[-1])
        cues = [str(item) for item in value.get("cues") or [] if item]
        observed = " ".join(
            [product.title, *(str(item) for item in (product.attrs or {}).values())]
        )
        lowered = observed.casefold()
        matched = text_matches_spec_cues(observed, attr, cues)
        evidence_ref = EvidenceRef(source="normalized", path="title/attrs", value=observed)
        if matched and _spec_evidence_conflicts(attr, observed, cues):
            return _assessment(
                constraint,
                AssessmentVerdict.UNKNOWN,
                f"spec_gate_conflict:{attr}",
                evidence_ref,
            )
        if matched:
            return _assessment(
                constraint,
                AssessmentVerdict.SATISFIED,
                f"spec_gate_match:{attr}",
                evidence_ref,
            )
        contradicted = attr == "4k" and _LOWER_THAN_4K.search(lowered) is not None
        refs = (
            (evidence_ref,)
            if contradicted
            else ()
        )
        return _assessment(
            constraint,
            AssessmentVerdict.VIOLATED if contradicted else AssessmentVerdict.UNKNOWN,
            f"spec_gate_mismatch:{attr}" if contradicted else f"spec_gate_unknown:{attr}",
            *refs,
        )
    if facet in {"platform", "merchant"}:
        expected = constraint.value
        expected_values = (
            [str(item).casefold() for item in expected]
            if isinstance(expected, list)
            else [str(expected).casefold()]
        )
        observed = " ".join(
            str(value)
            for value in (
                product.attrs.get("platform"),
                product.merchant,
                product.url,
            )
            if value
        )
        if not observed:
            return _assessment(constraint, AssessmentVerdict.UNKNOWN, f"{facet}_unknown")
        verdict = (
            AssessmentVerdict.SATISFIED
            if any(value in observed.casefold() for value in expected_values)
            else AssessmentVerdict.UNKNOWN
        )
        return _assessment(
            constraint,
            verdict,
            f"{facet}_match" if verdict == AssessmentVerdict.SATISFIED else f"{facet}_unverified",
            EvidenceRef(source="buywhere", path="merchant/url", value=observed),
        )
    if facet in {"model", "condition"}:
        expected = str(constraint.value).casefold()
        observed = (
            str(product.attrs.get(facet) or "")
            if facet == "condition"
            else product.title
        )
        if not observed:
            return _assessment(constraint, AssessmentVerdict.UNKNOWN, f"{facet}_unknown")
        verdict = (
            AssessmentVerdict.SATISFIED
            if expected in observed.casefold()
            else AssessmentVerdict.VIOLATED
        )
        return _assessment(
            constraint,
            verdict,
            f"{facet}_match" if verdict == AssessmentVerdict.SATISFIED else f"{facet}_mismatch",
            EvidenceRef(
                source="normalized",
                path="attrs.condition" if facet == "condition" else "title",
                value=observed,
            ),
        )
    return _assessment(constraint, AssessmentVerdict.UNKNOWN, "unsupported_constraint")


def _identity_constraints(
    goal: ShoppingGoal,
    contract: CategoryContract | None,
) -> list[GoalConstraint]:
    constraints: list[GoalConstraint] = []
    if goal.target.item_type:
        constraints.append(
            GoalConstraint(
                constraint_id="system:target_item_type",
                facet="item_type",
                value=goal.target.item_type,
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    constraints.append(
        GoalConstraint(
            constraint_id="system:target_relation",
            facet="relation",
            value=getattr(goal.target.relation_required, "value", goal.target.relation_required),
            unknown_policy=UnknownPolicy.BLOCK,
        )
    )
    if contract is not None:
        constraints.append(
            GoalConstraint(
                constraint_id="contract:allowed_relation",
                facet="allowed_relation",
                operator="in",
                value=sorted(contract.allowed_relations),
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    if goal.target.brand:
        constraints.append(
            GoalConstraint(
                constraint_id="system:target_brand",
                facet="brand",
                value=goal.target.brand,
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    if goal.target.model:
        constraints.append(
            GoalConstraint(
                constraint_id="system:target_model",
                facet="model",
                value=goal.target.model,
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    if goal.target.condition:
        constraints.append(
            GoalConstraint(
                constraint_id="system:target_condition",
                facet="condition",
                value=goal.target.condition,
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    if goal.retrieval_scope.platforms:
        constraints.append(
            GoalConstraint(
                constraint_id="system:platform",
                facet="platform",
                operator="in",
                value=list(goal.retrieval_scope.platforms),
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    if goal.retrieval_scope.merchants:
        constraints.append(
            GoalConstraint(
                constraint_id="system:merchant",
                facet="merchant",
                operator="in",
                value=list(goal.retrieval_scope.merchants),
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
    return constraints


def qualify_product(product: NormalizedProduct, goal: ShoppingGoal) -> CandidateQualification:
    profile = profile_product(product)
    contract = category_contract(goal.target.item_type)
    constraints = _identity_constraints(goal, contract) + [
        item for item in goal.constraints if item.status == "active" and item.hardness == "hard"
    ]
    assessments: list[ConstraintAssessment] = []
    for item in constraints:
        contract_facet = item.facet.split(":", 1)[0]
        supported = (
            contract is None
            or item.facet == "allowed_relation"
            or contract_facet in contract.supported_constraint_facets
        )
        assessment = (
            _assess_constraint(product, profile, item)
            if supported
            else _assessment(
                item,
                AssessmentVerdict.UNKNOWN,
                "constraint_not_supported_by_category",
            )
        )
        assessments.append(
            assessment.model_copy(update={"goal_version": goal.goal_version})
        )
    by_id = {item.constraint_id: item for item in constraints}
    if any(item.verdict == AssessmentVerdict.VIOLATED for item in assessments):
        eligibility = CandidateEligibility.INELIGIBLE
    elif any(
        item.verdict == AssessmentVerdict.UNKNOWN
        and by_id[item.constraint_id].unknown_policy == UnknownPolicy.BLOCK
        for item in assessments
    ):
        eligibility = CandidateEligibility.NEEDS_EVIDENCE
    else:
        eligibility = CandidateEligibility.ELIGIBLE
    return CandidateQualification(
        candidate_id=product.id,
        goal_version=goal.goal_version,
        profile=profile,
        assessments=assessments,
        eligibility=eligibility,
    )


def qualify_products(
    products: list[NormalizedProduct], goal: ShoppingGoal
) -> tuple[list[NormalizedProduct], list[CandidateQualification]]:
    qualifications = [qualify_product(item, goal) for item in products]
    eligible_ids = {
        item.candidate_id
        for item in qualifications
        if item.eligibility == CandidateEligibility.ELIGIBLE
    }
    return [item for item in products if item.id in eligible_ids], qualifications
