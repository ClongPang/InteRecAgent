from __future__ import annotations

from datetime import UTC, datetime, timedelta

from backend.application.services.rollout import RolloutSample, audit_release_health

NOW = datetime(2026, 8, 23, tzinfo=UTC)


def _sample(
    *,
    path: str = "explicit_v2",
    release_state: str = "full",
    status: str = "completed",
    eligibility: str = "eligible",
    verification: str = "passed",
    leaked: bool = False,
    latency_ms: int = 100,
    item_type: str = "smartphone",
    enabled_item_types: tuple[str, ...] = ("smartphone", "headphones"),
) -> RolloutSample:
    source_id = f"source-{item_type}"
    snapshot_id = f"snapshot-{item_type}"
    started = NOW - timedelta(milliseconds=latency_ms)
    return RolloutSample(
        run_id=f"run-{item_type}-{latency_ms}",
        observed_at=NOW - timedelta(days=1),
        status=status,
        execution_path=path,
        release_state=release_state,
        qualification_profile_version="ontology-rules-v10",
        enabled_item_types=list(enabled_item_types),
        run_latency_ms=latency_ms,
        candidate_payload={
            "item_type": item_type,
            "ranked": [{
                "snapshot_id": snapshot_id,
                "source_product_id": source_id,
                "decision_reasons": ["item_type_match", "lowest_estimated_cny"],
                "rank_explanation": {
                    "candidate_id": snapshot_id,
                    "assessment_reason_codes": ["item_type_match"],
                    "ranking_reason_codes": ["lowest_estimated_cny"],
                },
            }],
            "qualifications": [{
                "candidate_id": snapshot_id,
                "eligibility": eligibility,
                "assessments": [{"reason_code": "item_type_match"}],
            }],
            "coverage": {
                "status": "sufficient",
                "stop_reason": "coverage_sufficient",
                "request_count": 1,
                "request_budget": 6,
                "model_call_count": 1,
                "model_call_budget": 6,
                "estimated_token_count": 100,
                "token_budget": 12000,
                "consecutive_no_gain": 0,
            },
            "search_executions": [{
                "started_at": started.isoformat(),
                "completed_at": NOW.isoformat(),
            }],
        },
        final_payload={
            "verification": verification,
            "answer_plan": {
                "obligations": [{"facet": "recommendation", "status": "answered"}],
                "missing_facets": [],
            },
            "claim_ledger": {"claims": [{"claim_id": "claim-1"}]},
            "rendered_claim_ids": ["claim-1"],
        },
        agent_events=[{
            "event_type": "recommendation.ready",
            "text": f"推荐商品 {source_id}" if leaked else "推荐商品",
            "count": 1,
        }],
    )


def _audit(samples: list[RolloutSample], **overrides):
    options = {
        "now": NOW,
        "minimum_samples": 1,
        "minimum_latency_samples": 1,
        "required_item_types": ("smartphone",),
        "manual_audit_approved": True,
    }
    options.update(overrides)
    return audit_release_health(samples, **options)


def test_single_release_is_healthy_with_safe_evidence_and_signoff() -> None:
    report = _audit(
        [_sample(item_type="smartphone"), _sample(item_type="headphones")],
        required_item_types=("smartphone", "headphones"),
    )
    assert report.release_healthy is True
    assert report.blocking_reasons == []
    assert report.release is not None
    assert report.release.safety_failures == 0


def test_old_path_and_non_full_samples_are_excluded_not_compared() -> None:
    report = _audit([
        _sample(path="legacy_execute_ops"),
        _sample(release_state="canary"),
    ])
    assert report.excluded_non_current_path_count == 2
    assert report.release is None
    assert report.blocking_reasons == ["missing_release:explicit_v2"]


def test_safety_and_loop_contract_failures_block_release_health() -> None:
    sample = _sample(eligibility="needs_evidence", verification="failed", leaked=True)
    sample.candidate_payload["coverage"].update(
        request_count=7,
        request_budget=6,
        consecutive_no_gain=2,
        stop_reason="coverage_sufficient",
    )
    sample.candidate_payload["ranked"][0]["decision_reasons"].append("invented_reason")
    sample.final_payload["answer_plan"] = {
        "obligations": [{"facet": "stock", "status": "missing"}],
    }
    sample.final_payload["rendered_claim_ids"].append("invented-claim")
    report = _audit([sample])
    assert "safety_failure:explicit_v2" in report.blocking_reasons
    assert "loop_gate_failure:explicit_v2" in report.blocking_reasons
    assert report.release is not None
    assert report.release.hard_violation_count == 1
    assert report.release.unverified_answer_count == 1
    assert report.release.internal_id_leak_count == 1
    assert report.release.unanswered_obligation_count == 1
    assert report.release.renderer_claim_expansion_count == 1
    assert report.release.rank_explanation_violation_count == 1


def test_absolute_latency_budget_replaces_legacy_path_comparison() -> None:
    report = _audit([_sample(latency_ms=61_000)], max_p95_run_latency_ms=60_000)
    assert "p95_run_latency_over_budget:explicit_v2" in report.blocking_reasons


def test_volume_latency_category_and_manual_review_are_independent_gates() -> None:
    report = _audit(
        [_sample()],
        minimum_samples=2,
        minimum_latency_samples=2,
        required_item_types=("smartphone", "headphones"),
        manual_audit_approved=False,
    )
    assert "insufficient_samples:explicit_v2" in report.blocking_reasons
    assert "insufficient_latency_samples:explicit_v2" in report.blocking_reasons
    assert "missing_category:explicit_v2:headphones" in report.blocking_reasons
    assert "manual_audit_not_approved" in report.blocking_reasons


def test_stale_policy_feature_config_and_non_evaluable_runs_are_excluded() -> None:
    stale = _sample()
    stale.qualification_profile_version = "ontology-rules-v3"
    wrong_features = _sample(enabled_item_types=("smartphone",))
    superseded = _sample(status="superseded")
    report = _audit([stale, wrong_features, superseded])
    assert report.excluded_stale_sample_count == 1
    assert report.excluded_feature_flag_sample_count == 1
    assert report.excluded_non_evaluable_sample_count == 1


def test_failed_run_blocks_and_is_not_counted_as_latency_success() -> None:
    report = _audit([_sample(status="failed", latency_ms=900), _sample(latency_ms=100)])
    assert "failed_run:explicit_v2" in report.blocking_reasons
    assert report.release is not None
    assert report.release.sample_count == 2
    assert report.release.successful_sample_count == 1
    assert report.release.run_latency_sample_count == 1
    assert report.release.p95_run_latency_ms == 100


def test_disclosed_unknown_is_answered_by_contract() -> None:
    sample = _sample()
    sample.final_payload["answer_plan"] = {
        "obligations": [{"facet": "recommendation", "status": "unknown"}],
        "missing_facets": ["eligible_candidates"],
    }
    report = _audit([sample])
    assert report.release is not None
    assert report.release.unanswered_obligation_count == 0


def test_published_count_must_match_canonical_ranked_set() -> None:
    sample = _sample()
    sample.agent_events[0]["count"] = 2
    report = _audit([sample])
    assert report.release is not None
    assert report.release.canonical_set_mismatch_count == 1
    assert "safety_failure:explicit_v2" in report.blocking_reasons
