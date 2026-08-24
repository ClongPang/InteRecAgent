"""Pure health aggregation for the single released recommendation path."""
from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field


class RolloutSample(BaseModel):
    run_id: str
    observed_at: datetime
    status: str
    execution_path: str
    release_state: str = "unknown"
    qualification_profile_version: str = ""
    enabled_item_types: list[str] = Field(default_factory=list)
    run_latency_ms: int | None = Field(default=None, ge=0)
    candidate_payload: dict[str, Any] = Field(default_factory=dict)
    final_payload: dict[str, Any] = Field(default_factory=dict)
    agent_events: list[dict[str, Any]] = Field(default_factory=list)


class ReleaseMetrics(BaseModel):
    execution_path: str
    release_state_values: list[str] = Field(default_factory=list)
    sample_count: int
    successful_sample_count: int = 0
    observation_days: float
    qualification_profile_versions: list[str] = Field(default_factory=list)
    enabled_item_type_sets: list[list[str]] = Field(default_factory=list)
    run_latency_sample_count: int = 0
    p95_run_latency_ms: int | None = None
    p95_search_latency_ms: int | None = None
    hard_violation_count: int = 0
    unverified_answer_count: int = 0
    unanswered_obligation_count: int = 0
    renderer_claim_expansion_count: int = 0
    internal_id_leak_count: int = 0
    canonical_set_mismatch_count: int = 0
    rank_explanation_violation_count: int = 0
    failed_run_count: int = 0
    loop_budget_violation_count: int = 0
    loop_termination_violation_count: int = 0
    eligible_at_3: float | None = None
    coverage_status_counts: dict[str, int] = Field(default_factory=dict)
    category_counts: dict[str, int] = Field(default_factory=dict)

    @property
    def safety_failures(self) -> int:
        return (
            self.hard_violation_count
            + self.unverified_answer_count
            + self.unanswered_obligation_count
            + self.renderer_claim_expansion_count
            + self.internal_id_leak_count
            + self.canonical_set_mismatch_count
            + self.rank_explanation_violation_count
        )

    @property
    def loop_gate_failures(self) -> int:
        return self.loop_budget_violation_count + self.loop_termination_violation_count


class RolloutAuditReport(BaseModel):
    generated_at: datetime
    minimum_samples: int
    minimum_latency_samples: int
    max_p95_run_latency_ms: int
    required_item_types: list[str]
    required_qualification_profile_version: str
    required_enabled_item_types: list[str]
    excluded_stale_sample_count: int = 0
    excluded_feature_flag_sample_count: int = 0
    excluded_non_current_path_count: int = 0
    excluded_non_evaluable_sample_count: int = 0
    manual_audit_approved: bool
    release: ReleaseMetrics | None = None
    release_healthy: bool
    blocking_reasons: list[str] = Field(default_factory=list)


def audit_release_health(
    samples: list[RolloutSample],
    *,
    now: datetime | None = None,
    minimum_samples: int = 300,
    minimum_latency_samples: int = 30,
    max_p95_run_latency_ms: int = 60_000,
    required_item_types: tuple[str, ...] = ("smartphone", "headphones"),
    required_qualification_profile_version: str = "ontology-rules-v10",
    required_enabled_item_types: tuple[str, ...] = ("smartphone", "headphones"),
    manual_audit_approved: bool = False,
) -> RolloutAuditReport:
    """Evaluate immutable evidence for the only supported execution path."""
    now = now or datetime.now(UTC)
    profile_samples = [
        sample
        for sample in samples
        if sample.qualification_profile_version == required_qualification_profile_version
    ]
    required_enabled_set = tuple(sorted(set(required_enabled_item_types)))
    feature_compatible_samples = [
        sample
        for sample in profile_samples
        if tuple(sorted(set(sample.enabled_item_types))) == required_enabled_set
    ]
    path_samples = [
        sample
        for sample in feature_compatible_samples
        if sample.execution_path == "explicit_v2" and sample.release_state == "full"
    ]
    current_samples = [
        sample
        for sample in path_samples
        if sample.status == "failed"
        or (
            sample.status in {"completed", "degraded"}
            and bool(sample.candidate_payload)
        )
    ]
    release = _release_metrics(current_samples, now=now) if current_samples else None
    reasons: list[str] = []
    if release is None:
        reasons.append("missing_release:explicit_v2")
    else:
        if release.successful_sample_count < minimum_samples:
            reasons.append("insufficient_samples:explicit_v2")
        if release.run_latency_sample_count < minimum_latency_samples:
            reasons.append("insufficient_latency_samples:explicit_v2")
        for item_type in required_item_types:
            if release.category_counts.get(item_type, 0) == 0:
                reasons.append(f"missing_category:explicit_v2:{item_type}")
        if release.safety_failures:
            reasons.append("safety_failure:explicit_v2")
        if release.failed_run_count:
            reasons.append("failed_run:explicit_v2")
        if release.loop_gate_failures:
            reasons.append("loop_gate_failure:explicit_v2")
        if release.eligible_at_3 is not None and release.eligible_at_3 < 0.8:
            reasons.append("eligible_at_3_below_0_8:explicit_v2")
        if (
            release.run_latency_sample_count >= minimum_latency_samples
            and release.p95_run_latency_ms is not None
            and release.p95_run_latency_ms > max_p95_run_latency_ms
        ):
            reasons.append("p95_run_latency_over_budget:explicit_v2")
    if not manual_audit_approved:
        reasons.append("manual_audit_not_approved")
    return RolloutAuditReport(
        generated_at=now,
        minimum_samples=minimum_samples,
        minimum_latency_samples=minimum_latency_samples,
        max_p95_run_latency_ms=max_p95_run_latency_ms,
        required_item_types=list(required_item_types),
        required_qualification_profile_version=required_qualification_profile_version,
        required_enabled_item_types=list(required_enabled_set),
        excluded_stale_sample_count=len(samples) - len(profile_samples),
        excluded_feature_flag_sample_count=(
            len(profile_samples) - len(feature_compatible_samples)
        ),
        excluded_non_current_path_count=(
            len(feature_compatible_samples) - len(path_samples)
        ),
        excluded_non_evaluable_sample_count=(
            len(path_samples) - len(current_samples)
        ),
        manual_audit_approved=manual_audit_approved,
        release=release,
        release_healthy=not reasons,
        blocking_reasons=reasons,
    )


def _release_metrics(
    samples: list[RolloutSample],
    *,
    now: datetime,
) -> ReleaseMetrics:
    earliest = min(_aware(item.observed_at) for item in samples)
    successful_samples = [
        item for item in samples if item.status in {"completed", "degraded"}
    ]
    run_latencies = [
        item.run_latency_ms
        for item in successful_samples
        if item.run_latency_ms is not None
    ]
    latencies = [
        value
        for item in successful_samples
        if (value := _search_latency_ms(item)) is not None
    ]
    coverage: dict[str, int] = {}
    categories: dict[str, int] = {}
    hard_violations = 0
    unverified = 0
    unanswered_obligations = 0
    renderer_expansions = 0
    internal_leaks = 0
    count_mismatches = 0
    rank_explanation_violations = 0
    failed_runs = 0
    loop_budget_violations = 0
    loop_termination_violations = 0
    eligible_at_3_numerator = 0
    eligible_at_3_denominator = 0
    failed_runs = sum(sample.status == "failed" for sample in samples)
    for sample in successful_samples:
        payload = sample.candidate_payload
        status = str((payload.get("coverage") or {}).get("status") or "not_assessed")
        coverage[status] = coverage.get(status, 0) + 1
        item_type = str(payload.get("item_type") or "unknown")
        categories[item_type] = categories.get(item_type, 0) + 1
        hard_violations += _hard_violation_count(payload)
        unverified += int(sample.final_payload.get("verification") != "passed")
        unanswered_obligations += _unanswered_obligation_count(sample.final_payload)
        renderer_expansions += _renderer_claim_expansion_count(sample.final_payload)
        internal_leaks += _internal_id_leak_count(payload, sample.agent_events)
        count_mismatches += _canonical_set_mismatch_count(payload, sample.agent_events)
        rank_explanation_violations += _rank_explanation_violation_count(payload)
        loop_budget_violations += _loop_budget_violation_count(payload)
        loop_termination_violations += _loop_termination_violation_count(payload)
        numerator, denominator = _eligible_at_3_parts(payload)
        eligible_at_3_numerator += numerator
        eligible_at_3_denominator += denominator
    return ReleaseMetrics(
        execution_path="explicit_v2",
        release_state_values=sorted({item.release_state for item in samples}),
        sample_count=len(samples),
        successful_sample_count=len(successful_samples),
        observation_days=max(0.0, (_aware(now) - earliest).total_seconds() / 86_400),
        qualification_profile_versions=sorted(
            {item.qualification_profile_version for item in samples}
        ),
        enabled_item_type_sets=[
            list(item_types)
            for item_types in sorted(
                {tuple(sorted(set(item.enabled_item_types))) for item in samples}
            )
        ],
        run_latency_sample_count=len(run_latencies),
        p95_run_latency_ms=_p95(run_latencies),
        p95_search_latency_ms=_p95(latencies),
        hard_violation_count=hard_violations,
        unverified_answer_count=unverified,
        unanswered_obligation_count=unanswered_obligations,
        renderer_claim_expansion_count=renderer_expansions,
        internal_id_leak_count=internal_leaks,
        canonical_set_mismatch_count=count_mismatches,
        rank_explanation_violation_count=rank_explanation_violations,
        failed_run_count=failed_runs,
        loop_budget_violation_count=loop_budget_violations,
        loop_termination_violation_count=loop_termination_violations,
        eligible_at_3=(
            round(eligible_at_3_numerator / eligible_at_3_denominator, 4)
            if eligible_at_3_denominator
            else None
        ),
        coverage_status_counts=coverage,
        category_counts=categories,
    )


def _hard_violation_count(payload: dict[str, Any]) -> int:
    qualification_by_id = {
        str(item.get("candidate_id")): str(item.get("eligibility"))
        for item in payload.get("qualifications") or []
        if isinstance(item, dict) and item.get("candidate_id")
    }
    violations = 0
    for item in payload.get("ranked") or []:
        if not isinstance(item, dict):
            violations += 1
            continue
        identities = {
            str(value)
            for value in (item.get("snapshot_id"), item.get("source_product_id"))
            if value
        }
        if not identities or not any(qualification_by_id.get(key) == "eligible" for key in identities):
            violations += 1
    return violations


def _qualification_by_id(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("candidate_id")): item
        for item in payload.get("qualifications") or []
        if isinstance(item, dict) and item.get("candidate_id")
    }


def _eligible_at_3_parts(payload: dict[str, Any]) -> tuple[int, int]:
    qualifications = _qualification_by_id(payload)
    eligible_pool = sum(
        str(item.get("eligibility")) == "eligible" for item in qualifications.values()
    )
    if eligible_pool == 0:
        return 0, 0
    top_ranked = [item for item in (payload.get("ranked") or [])[:3] if isinstance(item, dict)]
    # eligible@3 evaluates the final recommendation surface, not every transient
    # qualification produced across coverage-loop iterations.  When the final
    # surface contains fewer than three unique candidates, score the actual
    # slots.  A feasible pool with no ranked output remains an explicit miss.
    target = len(top_ranked) or 1
    hits = 0
    for item in top_ranked:
        identities = {
            str(value)
            for value in (item.get("snapshot_id"), item.get("source_product_id"))
            if value
        }
        if any(
            str((qualifications.get(identity) or {}).get("eligibility")) == "eligible"
            for identity in identities
        ):
            hits += 1
    return hits, target


def _loop_budget_violation_count(payload: dict[str, Any]) -> int:
    coverage = payload.get("coverage") or {}
    pairs = (
        ("request_count", "request_budget"),
        ("model_call_count", "model_call_budget"),
        ("estimated_token_count", "token_budget"),
    )
    return int(
        any(
            isinstance(coverage.get(count_key), (int, float))
            and isinstance(coverage.get(budget_key), (int, float))
            and coverage[count_key] > coverage[budget_key]
            for count_key, budget_key in pairs
        )
    )


def _loop_termination_violation_count(payload: dict[str, Any]) -> int:
    coverage = payload.get("coverage") or {}
    if not coverage or not coverage.get("stop_reason"):
        return 1
    if int(coverage.get("consecutive_no_gain") or 0) < 2:
        return 0
    # The loop checks hard request/time/search ceilings before the no-gain
    # ceiling. Reaching both on the same iteration is a valid termination and
    # the persisted reason reflects that deterministic precedence.
    valid_reasons = {
        "consecutive_no_gain",
        "request_budget_exhausted",
        "time_budget_exhausted",
        "search_budget_exhausted",
    }
    return int(coverage.get("stop_reason") not in valid_reasons)


def _unanswered_obligation_count(final_payload: dict[str, Any]) -> int:
    plan = final_payload.get("answer_plan") or {}
    valid_statuses = {"answered", "unknown", "needs_research"}
    unresolved: set[str] = set()
    for item in plan.get("obligations") or []:
        if not isinstance(item, dict):
            unresolved.add("unknown")
        elif item.get("status") not in valid_statuses:
            unresolved.add(str(item.get("facet") or "unknown"))
    # missing_facets records disclosed evidence gaps. It is not an unanswered
    # question when the corresponding obligation is explicitly `unknown` or
    # `needs_research`, both valid states in the V2 AnswerPlan contract.
    return len(unresolved)


def _renderer_claim_expansion_count(final_payload: dict[str, Any]) -> int:
    ledger_ids = {
        str(item.get("claim_id"))
        for item in (final_payload.get("claim_ledger") or {}).get("claims") or []
        if isinstance(item, dict) and item.get("claim_id")
    }
    rendered_ids = {
        str(item)
        for key in ("rendered_claim_ids", "recommendation_rendered_claim_ids")
        for item in final_payload.get(key) or []
        if item
    }
    return len(rendered_ids - ledger_ids)


def _rank_explanation_violation_count(payload: dict[str, Any]) -> int:
    qualifications = _qualification_by_id(payload)
    violations = 0
    for ranked in payload.get("ranked") or []:
        if not isinstance(ranked, dict):
            violations += 1
            continue
        candidate_id = str(ranked.get("snapshot_id") or ranked.get("source_product_id") or "")
        qualification = qualifications.get(candidate_id) or {}
        assessment_codes = {
            str(item.get("reason_code"))
            for item in qualification.get("assessments") or []
            if isinstance(item, dict) and item.get("reason_code")
        }
        explanation = ranked.get("rank_explanation") or {}
        explanation_assessments = {
            str(item) for item in explanation.get("assessment_reason_codes") or [] if item
        }
        ranking_codes = {
            str(item) for item in explanation.get("ranking_reason_codes") or [] if item
        }
        decision_reasons = {
            str(item) for item in ranked.get("decision_reasons") or [] if item
        }
        if (
            not candidate_id
            or not qualification
            or str(explanation.get("candidate_id") or "") != candidate_id
            or not explanation_assessments.issubset(assessment_codes)
            or not decision_reasons.issubset(assessment_codes | ranking_codes)
        ):
            violations += 1
    return violations


def _internal_id_leak_count(
    payload: dict[str, Any], agent_events: list[dict[str, Any]]
) -> int:
    source_ids = {
        str(item.get("source_product_id"))
        for item in payload.get("ranked") or []
        if isinstance(item, dict) and item.get("source_product_id")
    }
    texts = [str(item.get("text") or "") for item in agent_events]
    return sum(any(source_id in text for text in texts) for source_id in source_ids)


def _canonical_set_mismatch_count(
    payload: dict[str, Any], agent_events: list[dict[str, Any]]
) -> int:
    ranked_count = len(payload.get("ranked") or [])
    published_counts = [
        int(item["count"])
        for item in agent_events
        if item.get("event_type") in {"recommendation.ready", "run.degraded"}
        and isinstance(item.get("count"), int)
    ]
    return int(any(count != ranked_count for count in published_counts))


def _search_latency_ms(sample: RolloutSample) -> int | None:
    executions = sample.candidate_payload.get("search_executions") or []
    starts: list[datetime] = []
    ends: list[datetime] = []
    for item in executions:
        if not isinstance(item, dict):
            continue
        try:
            starts.append(_parse_datetime(item["started_at"]))
            ends.append(_parse_datetime(item["completed_at"]))
        except (KeyError, TypeError, ValueError):
            continue
    if not starts or not ends:
        return None
    return max(0, round((max(ends) - min(starts)).total_seconds() * 1000))


def _p95(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def _parse_datetime(value: str) -> datetime:
    return _aware(datetime.fromisoformat(str(value).replace("Z", "+00:00")))


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
