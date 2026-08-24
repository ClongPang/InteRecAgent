"""Versioned category-release contracts.

Recognising a word in a listing is not sufficient authority to recommend that
category.  A contract binds a category's semantic boundary, evidence policy,
and release lifecycle.  Runtime flags can narrow this set, never promote an
offline category by themselves.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class CategoryLifecycle(StrEnum):
    OFFLINE = "offline"
    SHADOW = "shadow"
    CANARY = "canary"
    ENABLED = "enabled"


class SemanticProfileMode(StrEnum):
    RULE_ONLY = "rule_only"
    SHADOW = "shadow"
    ADJUDICATED = "adjudicated"


@dataclass(frozen=True)
class CategoryContract:
    category_id: str
    lifecycle: CategoryLifecycle
    semantic_profile_mode: SemanticProfileMode
    allowed_relations: frozenset[str]
    required_evidence_facets: frozenset[str]
    supported_constraint_facets: frozenset[str]
    taxonomy_version: str
    qualification_profile_version: str
    gold_dataset_version: str

    @property
    def is_publishable(self) -> bool:
        return self.lifecycle in {CategoryLifecycle.CANARY, CategoryLifecycle.ENABLED}


# The first vertical slice is deliberately closed.  Monitor rules may exist for
# offline evaluation, but cannot enter the online qualification path until this
# contract is reviewed and its lifecycle changes in a versioned code release.
CATEGORY_CONTRACTS: dict[str, CategoryContract] = {
    "smartphone": CategoryContract(
        category_id="smartphone",
        lifecycle=CategoryLifecycle.CANARY,
        semantic_profile_mode=SemanticProfileMode.SHADOW,
        allowed_relations=frozenset({"product"}),
        required_evidence_facets=frozenset({"identity", "budget"}),
        supported_constraint_facets=frozenset(
            {"item_type", "relation", "budget", "brand", "model", "condition", "stock", "platform", "merchant", "exclude_term", "spec_gate"}
        ),
        taxonomy_version="consumer-electronics-v1",
        qualification_profile_version="ontology-rules-v10",
        gold_dataset_version="qualification-gold-v2",
    ),
    "headphones": CategoryContract(
        category_id="headphones",
        lifecycle=CategoryLifecycle.CANARY,
        semantic_profile_mode=SemanticProfileMode.SHADOW,
        allowed_relations=frozenset({"product"}),
        required_evidence_facets=frozenset({"identity", "budget"}),
        supported_constraint_facets=frozenset(
            {"item_type", "relation", "budget", "brand", "model", "condition", "stock", "platform", "merchant", "exclude_term", "spec_gate"}
        ),
        taxonomy_version="consumer-electronics-v1",
        qualification_profile_version="ontology-rules-v10",
        gold_dataset_version="qualification-gold-v2",
    ),
    "monitor": CategoryContract(
        category_id="monitor",
        lifecycle=CategoryLifecycle.OFFLINE,
        semantic_profile_mode=SemanticProfileMode.RULE_ONLY,
        allowed_relations=frozenset({"product"}),
        required_evidence_facets=frozenset({"identity", "budget", "specification"}),
        supported_constraint_facets=frozenset(
            {"item_type", "relation", "budget", "brand", "model", "condition", "stock", "platform", "merchant", "exclude_term", "spec_gate"}
        ),
        taxonomy_version="consumer-electronics-v1",
        qualification_profile_version="ontology-rules-v10",
        gold_dataset_version="qualification-gold-v2",
    ),
}


def publishable_item_types(requested: set[str] | frozenset[str] | list[str]) -> frozenset[str]:
    """Intersect a runtime request with independently approved contracts."""
    return frozenset(
        category_id
        for category_id in requested
        if (contract := CATEGORY_CONTRACTS.get(category_id)) is not None
        and contract.is_publishable
    )


def category_contract(category_id: str | None) -> CategoryContract | None:
    return CATEGORY_CONTRACTS.get(category_id or "")


def semantic_shadow_enabled(category_id: str | None) -> bool:
    contract = category_contract(category_id)
    return bool(contract and contract.semantic_profile_mode == SemanticProfileMode.SHADOW)


def validate_category_contracts(
    *,
    qualification_profile_version: str,
    detected_item_types: frozenset[str],
) -> None:
    """Fail closed when a publishable contract cannot be executed by this runtime."""
    supported_evidence = {"identity", "budget", "specification"}
    for contract in CATEGORY_CONTRACTS.values():
        if not contract.allowed_relations:
            raise ValueError(f"category contract has no allowed relation: {contract.category_id}")
        if not contract.required_evidence_facets <= supported_evidence:
            raise ValueError(f"category contract requests unsupported evidence: {contract.category_id}")
        if (
            contract.lifecycle == CategoryLifecycle.OFFLINE
            and contract.semantic_profile_mode == SemanticProfileMode.ADJUDICATED
        ):
            raise ValueError(f"offline category cannot enforce model adjudication: {contract.category_id}")
        if contract.is_publishable and contract.category_id not in detected_item_types:
            raise ValueError(f"publishable category has no semantic detector: {contract.category_id}")
        if (
            contract.is_publishable
            and contract.qualification_profile_version != qualification_profile_version
        ):
            raise ValueError(f"qualification profile drift: {contract.category_id}")
