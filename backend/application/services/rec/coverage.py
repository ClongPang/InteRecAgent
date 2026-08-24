from __future__ import annotations

from ...dto.coverage import CoverageStatus, GoalCoverage
from ...dto.qualification import CandidateEligibility, CandidateQualification


def eligible_candidate_markets(
    products: list,
    qualifications: list[CandidateQualification],
    *,
    snapshot_map: dict[str, str] | None = None,
) -> list[str]:
    """Resolve markets across source-id and persisted snapshot-id namespaces."""
    eligible_ids = {
        item.candidate_id
        for item in qualifications
        if item.eligibility == CandidateEligibility.ELIGIBLE
    }
    snapshots = snapshot_map or {}
    return [
        product.country_code
        for product in products
        if product.country_code
        and (product.id in eligible_ids or snapshots.get(product.id) in eligible_ids)
    ]


def assess_goal_coverage(
    qualifications: list[CandidateQualification],
    *,
    goal_version: int,
    minimum_eligible: int = 1,
    search_attempt_count: int = 0,
    request_count: int = 0,
    request_budget: int | None = None,
    remaining_time_ms: int | None = None,
    model_call_count: int = 0,
    model_call_budget: int | None = None,
    estimated_token_count: int = 0,
    token_budget: int | None = None,
    marginal_unique_observations: int = 0,
    marginal_eligible_count: int = 0,
    consecutive_no_gain: int = 0,
    stop_reason: str | None = None,
    requested_markets: list[str] | None = None,
    eligible_markets: list[str] | None = None,
    preference_evidence_coverage: dict[str, float] | None = None,
) -> GoalCoverage:
    eligible = sum(item.eligibility == CandidateEligibility.ELIGIBLE for item in qualifications)
    ineligible = sum(item.eligibility == CandidateEligibility.INELIGIBLE for item in qualifications)
    needs_evidence = sum(
        item.eligibility == CandidateEligibility.NEEDS_EVIDENCE for item in qualifications
    )
    reasons = sorted(
        {
            assessment.reason_code
            for item in qualifications
            if item.eligibility == CandidateEligibility.NEEDS_EVIDENCE
            for assessment in item.assessments
            if assessment.verdict == "unknown"
        }
    )
    requested = list(dict.fromkeys(code.upper() for code in (requested_markets or []) if code))
    covered_set = {code.upper() for code in (eligible_markets or []) if code}
    covered = [code for code in requested if code in covered_set]
    missing = [code for code in requested if code not in covered_set]
    reasons.extend(f"requested_market_uncovered:{code}" for code in missing)
    reasons = sorted(set(reasons))
    identity_complete = 0
    evidence_counts: dict[str, tuple[int, int]] = {}
    for item in qualifications:
        identity = [
            assessment
            for assessment in item.assessments
            if assessment.constraint_id in {"system:target_item_type", "system:target_relation"}
        ]
        if identity and all(assessment.verdict == "satisfied" for assessment in identity):
            identity_complete += 1
        for assessment in item.assessments:
            known, total = evidence_counts.get(assessment.constraint_id, (0, 0))
            evidence_counts[assessment.constraint_id] = (
                known + (assessment.verdict != "unknown"),
                total + 1,
            )
    if eligible >= minimum_eligible and not missing:
        status = CoverageStatus.SUFFICIENT
    elif eligible < minimum_eligible and needs_evidence:
        status = CoverageStatus.BLOCKED_ON_EVIDENCE
    else:
        status = CoverageStatus.INSUFFICIENT
    return GoalCoverage(
        goal_version=goal_version,
        status=status,
        eligible_count=eligible,
        ineligible_count=ineligible,
        needs_evidence_count=needs_evidence,
        blocking_reason_codes=reasons,
        requested_markets=requested,
        covered_markets=covered,
        missing_markets=missing,
        identity_purity=round(identity_complete / len(qualifications), 4)
        if qualifications
        else 0.0,
        hard_constraint_evidence_coverage={
            ident: round(known / total, 4) if total else 0.0
            for ident, (known, total) in evidence_counts.items()
        },
        preference_evidence_coverage=dict(preference_evidence_coverage or {}),
        attempted_candidate_count=len(qualifications),
        search_attempt_count=search_attempt_count,
        request_count=request_count,
        request_budget=request_budget,
        remaining_request_budget=(
            max(0, request_budget - request_count) if request_budget is not None else None
        ),
        remaining_time_ms=remaining_time_ms,
        model_call_count=model_call_count,
        model_call_budget=model_call_budget,
        remaining_model_calls=(
            max(0, model_call_budget - model_call_count) if model_call_budget is not None else None
        ),
        estimated_token_count=estimated_token_count,
        token_budget=token_budget,
        remaining_token_budget=(
            max(0, token_budget - estimated_token_count) if token_budget is not None else None
        ),
        marginal_unique_observations=marginal_unique_observations,
        marginal_eligible_count=marginal_eligible_count,
        consecutive_no_gain=consecutive_no_gain,
        stop_reason=stop_reason,
    )
