"""Evidence-bound semantic profiling and adjudication.

The deterministic layer is a high-precision guard and offline fallback.  A
model classifier may propose a profile, but cannot override contradictory
observed evidence or promote an unsupported label.  Ambiguity is represented
as UNKNOWN rather than repaired with another bad-case rule.
"""
from __future__ import annotations

import re
from urllib.parse import unquote, urlparse

from ....domain.models import NormalizedProduct
from ....domain.product_ontology import classify_item_type, classify_relation
from ...dto.qualification import (
    EvidenceRef,
    ProductSemanticProfile,
    SemanticProfileMethod,
)

PROFILE_VERSION = "ontology-rules-v10"
SEMANTIC_MODEL_SHADOW_VERSION = "semantic-model-shadow-v1"
MODEL_ACCEPTANCE_THRESHOLD = 0.85
_BLOCKING_RELATIONS = {"accessory", "replacement", "service", "consumable"}


def build_rule_profile(product: NormalizedProduct) -> ProductSemanticProfile:
    """Build the auditable high-precision profile used when no model is available."""
    semantic_fields = [
        ("normalized.title", product.title or ""),
        ("metadata.category", product.attrs.get("category", "")),
        ("metadata.product_type", product.attrs.get("product_type", "")),
        ("metadata.tags", product.attrs.get("tags", "")),
    ]
    combined = " | ".join(value for _, value in semantic_fields)
    relation, relation_span = classify_relation(combined)
    item_type, item_span = classify_item_type(*(value for _, value in semantic_fields))
    if relation == "unknown" and item_type is not None:
        relation = "product"

    url_text = re.sub(
        r"[-_./]+",
        " ",
        unquote(urlparse(product.url or "").path),
    ).strip()
    url_relation, url_relation_span = classify_relation(url_text)
    url_item_type, url_item_span = classify_item_type(url_text)
    conflicts: list[str] = []
    if relation == "product" and url_relation in _BLOCKING_RELATIONS:
        relation = "unknown"
        conflicts.append("relation_conflicts_with_url")
    if item_type is not None and url_item_type is not None and item_type != url_item_type:
        item_type = None
        conflicts.append("item_type_conflicts_with_url")

    brand = product.attrs.get("brand") or product.attrs.get("vendor")
    if item_type == "smartphone" and "iphone" in product.title.casefold() and not brand:
        brand = "Apple"
    matched = [span for span in (relation_span, item_span) if span]
    refs = [
        EvidenceRef(
            source="buywhere" if path.startswith("metadata.") else "normalized",
            path=path,
            value=value,
            evidence_level="observed",
        )
        for path, value in semantic_fields
        if value and any(span.casefold() in value.casefold() for span in matched)
    ]
    if conflicts:
        refs.append(
            EvidenceRef(
                source="buywhere",
                path="url.path",
                value=url_text,
                evidence_level="conflicting",
            )
        )
        matched.extend(
            span
            for span in (url_relation_span, url_item_span)
            if span and span not in matched
        )
    return ProductSemanticProfile(
        category_id=item_type,
        item_type=item_type,
        relation=relation,
        brand=brand,
        model=product.attrs.get("model"),
        method=SemanticProfileMethod.RULE,
        confidence=(
            0.98
            if not conflicts and relation != "unknown" and item_type is not None
            else (0.95 if not conflicts and relation != "unknown" else 0.0)
        ),
        evidence_spans=matched,
        evidence_refs=refs,
        conflict_reason_codes=conflicts,
        classifier_version=PROFILE_VERSION,
    )


def adjudicate_profile(
    guard: ProductSemanticProfile,
    proposal: ProductSemanticProfile | None,
    *,
    minimum_model_confidence: float = MODEL_ACCEPTANCE_THRESHOLD,
) -> ProductSemanticProfile:
    """Combine a guard and model proposal without allowing silent promotion.

    A caller may later obtain ``proposal`` from any structured classifier.  The
    pure adjudicator keeps provider facts and policy independent from that
    model implementation.
    """
    if proposal is None:
        return guard
    conflicts = list(guard.conflict_reason_codes)
    if proposal.method == SemanticProfileMethod.RULE:
        conflicts.append("proposal_not_model_derived")
    if proposal.confidence < minimum_model_confidence:
        conflicts.append("model_confidence_below_threshold")
    if not proposal.evidence_spans or not proposal.evidence_refs:
        conflicts.append("model_proposal_missing_evidence")
    if guard.item_type and proposal.item_type and guard.item_type != proposal.item_type:
        conflicts.append("guard_model_item_type_conflict")
    if (
        guard.relation != "unknown"
        and proposal.relation != "unknown"
        and guard.relation != proposal.relation
    ):
        conflicts.append("guard_model_relation_conflict")
    if conflicts:
        return guard.model_copy(
            update={
                "category_id": None,
                "item_type": None,
                "relation": "unknown",
                "brand": None,
                "model": None,
                "derived_attrs": {},
                "method": SemanticProfileMethod.ADJUDICATED,
                "confidence": 0.0,
                "conflict_reason_codes": list(dict.fromkeys(conflicts)),
            }
        )
    return proposal.model_copy(
        update={
            "category_id": proposal.category_id or proposal.item_type,
            "method": SemanticProfileMethod.ADJUDICATED,
            "classifier_version": (
                f"{guard.classifier_version}+{proposal.classifier_version}"
            ),
        }
    )


def profile_product(product: NormalizedProduct) -> ProductSemanticProfile:
    """Current production entrypoint; model proposals are shadow-only for now."""
    return adjudicate_profile(build_rule_profile(product), None)
