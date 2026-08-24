from __future__ import annotations

from ...dto.answer import ClaimLedger


class ClaimVerificationError(ValueError):
    pass


def _same_evidence_value(left, right) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    return left == right


def verify_claim_ledger(
    ledger: ClaimLedger,
    *,
    displayed_snapshot_ids: set[str],
) -> ClaimLedger:
    """事实门禁：外部商品事实必须有证据，且 subject 属于 canonical 展示集。"""
    for claim in ledger.claims:
        if claim.subject.startswith("source:"):
            raise ClaimVerificationError("source product id must not be exposed")
        if claim.subject not in displayed_snapshot_ids and claim.subject not in {"mission", "set"}:
            raise ClaimVerificationError("claim subject is outside canonical candidate set")
        if claim.wording_policy == "factual" and not claim.evidence_refs:
            raise ClaimVerificationError("factual claim has no evidence")
        if claim.wording_policy == "factual" and not any(
            _same_evidence_value(claim.value, ref.value) for ref in claim.evidence_refs
        ):
            raise ClaimVerificationError("factual claim value is not supported by evidence")
    return ledger


def verify_rendered_answer(
    text: str,
    ledger: ClaimLedger,
    *,
    forbidden_source_ids: set[str] | None = None,
    rendered_claim_ids: set[str] | frozenset[str] | None = None,
) -> str:
    """Final output gate for renderer non-expansion and provider-ID isolation."""
    for source_id in forbidden_source_ids or set():
        if source_id and source_id in text:
            raise ClaimVerificationError("source product id leaked into rendered answer")
    if rendered_claim_ids is not None:
        claims = {claim.claim_id: claim for claim in ledger.claims}
        unknown = set(rendered_claim_ids) - claims.keys()
        if unknown:
            raise ClaimVerificationError("renderer referenced claim outside ledger")
        for claim_id in rendered_claim_ids:
            claim = claims[claim_id]
            if claim.wording_policy == "factual" and not claim.evidence_refs:
                raise ClaimVerificationError("renderer referenced unsupported factual claim")
    return text
