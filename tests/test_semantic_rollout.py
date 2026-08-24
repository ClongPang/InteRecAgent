from __future__ import annotations

from datetime import UTC, datetime

from backend.application.dto import EvidenceRef, ProductSemanticProfile, SemanticProfileMethod
from backend.application.services.rec.semantic import (
    PROFILE_VERSION,
    SEMANTIC_MODEL_SHADOW_VERSION,
)
from backend.application.services.semantic_rollout import (
    SemanticShadowRun,
    audit_semantic_shadow,
)

NOW = datetime(2026, 8, 24, tzinfo=UTC)


def profile(
    item_type: str | None,
    relation: str,
    *,
    method: SemanticProfileMethod,
    conflicts: list[str] | None = None,
) -> dict:
    span = "Headphones" if item_type else "ambiguous"
    return ProductSemanticProfile(
        category_id=item_type,
        item_type=item_type,
        relation=relation,
        method=method,
        confidence=0.98 if item_type else 0.0,
        evidence_spans=[span],
        evidence_refs=[
            EvidenceRef(source="normalized", path="normalized.title", value=span)
        ],
        conflict_reason_codes=conflicts or [],
        classifier_version=(
            PROFILE_VERSION
            if method == SemanticProfileMethod.RULE
            else SEMANTIC_MODEL_SHADOW_VERSION
        ),
    ).model_dump(mode="json")


def run(
    run_id: str,
    category: str,
    *,
    guard: dict | None = None,
    adjudicated: dict | None = None,
    invalid: int = 0,
    valid_spans: int = 1,
) -> SemanticShadowRun:
    guard = guard or profile(category, "product", method=SemanticProfileMethod.RULE)
    adjudicated = adjudicated or profile(
        category, "product", method=SemanticProfileMethod.ADJUDICATED
    )
    return SemanticShadowRun(
        run_id=run_id,
        observed_at=NOW,
        candidate_payload={
            "item_type": category,
            "semantic_shadow_stats": {
                "attempted_count": 1,
                "proposal_count": 1,
                "invalid_proposal_count": invalid,
                "raw_evidence_span_count": 1,
                "valid_evidence_span_count": valid_spans,
            },
            "semantic_profile_proposals": {
                "candidate-1": {
                    **adjudicated,
                    "method": SemanticProfileMethod.MODEL,
                    "classifier_version": SEMANTIC_MODEL_SHADOW_VERSION,
                }
            },
            "semantic_profile_shadow": {
                "candidate-1": {
                    "observed_text": "Example Headphones",
                    "guard": guard,
                    "adjudicated": adjudicated,
                    "would_change_active_profile": guard != adjudicated,
                }
            },
        },
    )


def test_semantic_shadow_gate_passes_only_complete_safe_evidence() -> None:
    report = audit_semantic_shadow(
        [run("phone-run", "smartphone"), run("audio-run", "headphones")],
        now=NOW,
        minimum_samples_per_category=1,
    )
    assert report.promotion_ready is True
    assert report.blocking_reasons == []
    assert {item.category_id for item in report.categories} == {
        "smartphone",
        "headphones",
    }


def test_semantic_shadow_gate_blocks_missing_category_and_invalid_evidence() -> None:
    report = audit_semantic_shadow(
        [run("phone-run", "smartphone", invalid=1, valid_spans=0)],
        now=NOW,
        minimum_samples_per_category=1,
    )
    assert report.promotion_ready is False
    assert "missing_category:headphones" in report.blocking_reasons
    assert "invalid_model_proposals:smartphone" in report.blocking_reasons
    assert "invalid_or_missing_evidence_spans:smartphone" in report.blocking_reasons


def test_unknown_to_known_model_promotion_requires_explicit_review() -> None:
    unknown = profile(None, "unknown", method=SemanticProfileMethod.RULE)
    promoted = profile(
        "headphones", "product", method=SemanticProfileMethod.ADJUDICATED
    )
    sample = run(
        "audio-run",
        "headphones",
        guard=unknown,
        adjudicated=promoted,
    )
    blocked = audit_semantic_shadow(
        [sample],
        now=NOW,
        required_categories=("headphones",),
        minimum_samples_per_category=1,
    )
    assert "unreviewed_model_promotions:headphones" in blocked.blocking_reasons

    reviewed = audit_semantic_shadow(
        [sample],
        now=NOW,
        required_categories=("headphones",),
        minimum_samples_per_category=1,
        reviewed_decisions={"audio-run:candidate-1"},
    )
    assert reviewed.promotion_ready is True


def test_semantic_shadow_gate_rejects_mixed_classifier_versions() -> None:
    sample = run("audio-run", "headphones")
    sample.candidate_payload["semantic_profile_proposals"]["candidate-1"][
        "classifier_version"
    ] = "stale-model-v0"
    report = audit_semantic_shadow(
        [sample],
        now=NOW,
        required_categories=("headphones",),
        minimum_samples_per_category=1,
    )
    assert "semantic_profile_version_mismatch:headphones" in report.blocking_reasons
