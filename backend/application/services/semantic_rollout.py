"""Pure semantic-shadow evidence aggregation and promotion gates."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from ..dto.qualification import ProductSemanticProfile
from .rec.semantic import PROFILE_VERSION, SEMANTIC_MODEL_SHADOW_VERSION


class SemanticShadowRun(BaseModel):
    run_id: str
    observed_at: datetime
    candidate_payload: dict[str, Any] = Field(default_factory=dict)


class CategorySemanticShadowMetrics(BaseModel):
    category_id: str
    run_count: int = 0
    observation_count: int = 0
    observation_days: float = 0.0
    attempted_count: int = 0
    proposal_count: int = 0
    invalid_proposal_count: int = 0
    version_mismatch_count: int = 0
    evidence_span_count: int = 0
    valid_evidence_span_count: int = 0
    conflict_count: int = 0
    abstention_count: int = 0
    active_profile_change_count: int = 0
    model_promotion_count: int = 0
    unreviewed_model_promotion_count: int = 0

    @property
    def schema_validity(self) -> float | None:
        if self.attempted_count == 0:
            return None
        return max(0.0, 1 - self.invalid_proposal_count / self.attempted_count)

    @property
    def evidence_span_validity(self) -> float | None:
        if self.evidence_span_count == 0:
            return None
        return self.valid_evidence_span_count / self.evidence_span_count

    @property
    def abstention_rate(self) -> float | None:
        if self.observation_count == 0:
            return None
        return self.abstention_count / self.observation_count

    @property
    def conflict_rate(self) -> float | None:
        if self.observation_count == 0:
            return None
        return self.conflict_count / self.observation_count


class SemanticShadowAuditReport(BaseModel):
    generated_at: datetime
    minimum_samples_per_category: int
    required_guard_version: str
    required_model_version: str
    required_categories: list[str]
    categories: list[CategorySemanticShadowMetrics] = Field(default_factory=list)
    promotion_ready: bool
    blocking_reasons: list[str] = Field(default_factory=list)


def _known(profile: ProductSemanticProfile) -> bool:
    return bool(profile.item_type and profile.relation != "unknown")


def audit_semantic_shadow(
    runs: list[SemanticShadowRun],
    *,
    now: datetime | None = None,
    required_categories: tuple[str, ...] = ("smartphone", "headphones"),
    minimum_samples_per_category: int = 100,
    required_guard_version: str = PROFILE_VERSION,
    required_model_version: str = SEMANTIC_MODEL_SHADOW_VERSION,
    reviewed_decisions: set[str] | frozenset[str] | None = None,
) -> SemanticShadowAuditReport:
    """Evaluate immutable shadow artifacts without changing runtime flags."""
    now = now or datetime.now(UTC)
    reviewed = set(reviewed_decisions or set())
    grouped: dict[str, list[SemanticShadowRun]] = {}
    for run in runs:
        category = str(run.candidate_payload.get("item_type") or "")
        if category:
            grouped.setdefault(category, []).append(run)

    metrics_list: list[CategorySemanticShadowMetrics] = []
    reasons: list[str] = []
    for category in required_categories:
        category_runs = grouped.get(category, [])
        if not category_runs:
            reasons.append(f"missing_category:{category}")
            continue
        metrics = CategorySemanticShadowMetrics(
            category_id=category,
            run_count=len(category_runs),
            observation_days=max(
                0.0,
                (
                    max(run.observed_at for run in category_runs)
                    - min(run.observed_at for run in category_runs)
                ).total_seconds()
                / 86_400,
            ),
        )
        for run in category_runs:
            payload = run.candidate_payload
            stats = dict(payload.get("semantic_shadow_stats") or {})
            proposals = dict(payload.get("semantic_profile_proposals") or {})
            metrics.attempted_count += int(stats.get("attempted_count") or 0)
            metrics.proposal_count += int(stats.get("proposal_count") or 0)
            metrics.invalid_proposal_count += int(
                stats.get("invalid_proposal_count") or 0
            )
            metrics.evidence_span_count += int(
                stats.get("raw_evidence_span_count") or 0
            )
            metrics.valid_evidence_span_count += int(
                stats.get("valid_evidence_span_count") or 0
            )
            for candidate_id, raw in dict(
                payload.get("semantic_profile_shadow") or {}
            ).items():
                if not isinstance(raw, dict):
                    metrics.invalid_proposal_count += 1
                    continue
                try:
                    guard = ProductSemanticProfile.model_validate(raw.get("guard") or {})
                    adjudicated = ProductSemanticProfile.model_validate(
                        raw.get("adjudicated") or {}
                    )
                except ValueError:
                    metrics.invalid_proposal_count += 1
                    continue
                proposal_raw = proposals.get(candidate_id)
                try:
                    proposal = ProductSemanticProfile.model_validate(proposal_raw or {})
                except ValueError:
                    metrics.invalid_proposal_count += 1
                    continue
                if (
                    guard.classifier_version != required_guard_version
                    or proposal.classifier_version != required_model_version
                ):
                    metrics.version_mismatch_count += 1
                metrics.observation_count += 1
                if adjudicated.conflict_reason_codes:
                    metrics.conflict_count += 1
                if not _known(adjudicated):
                    metrics.abstention_count += 1
                if bool(raw.get("would_change_active_profile")):
                    metrics.active_profile_change_count += 1
                if not _known(guard) and _known(adjudicated):
                    metrics.model_promotion_count += 1
                    decision_id = f"{run.run_id}:{candidate_id}"
                    if decision_id not in reviewed:
                        metrics.unreviewed_model_promotion_count += 1
        metrics_list.append(metrics)
        if metrics.observation_count < minimum_samples_per_category:
            reasons.append(f"insufficient_samples:{category}")
        if metrics.attempted_count == 0:
            reasons.append(f"no_classifier_attempts:{category}")
        if metrics.invalid_proposal_count:
            reasons.append(f"invalid_model_proposals:{category}")
        if metrics.version_mismatch_count:
            reasons.append(f"semantic_profile_version_mismatch:{category}")
        if metrics.evidence_span_validity != 1.0:
            reasons.append(f"invalid_or_missing_evidence_spans:{category}")
        if metrics.unreviewed_model_promotion_count:
            reasons.append(f"unreviewed_model_promotions:{category}")

    return SemanticShadowAuditReport(
        generated_at=now,
        minimum_samples_per_category=minimum_samples_per_category,
        required_guard_version=required_guard_version,
        required_model_version=required_model_version,
        required_categories=list(required_categories),
        categories=metrics_list,
        promotion_ready=not reasons,
        blocking_reasons=reasons,
    )
