from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class ConstraintHardness(StrEnum):
    HARD = "hard"
    SOFT = "soft"


class ConstraintStatus(StrEnum):
    ACTIVE = "active"
    SUPERSEDED = "superseded"
    RETRACTED = "retracted"


class UnknownPolicy(StrEnum):
    BLOCK = "block"
    DISCLOSE = "disclose"
    ALLOW = "allow"


class ProductRelation(StrEnum):
    PRODUCT = "product"
    ACCESSORY = "accessory"
    BUNDLE = "bundle"
    CONSUMABLE = "consumable"
    REPLACEMENT = "replacement"
    SERVICE = "service"
    UNKNOWN = "unknown"


class RejectedEntityKind(StrEnum):
    """Stable identity namespace for an explicit Goal rejection."""

    TERM = "term"
    SNAPSHOT = "snapshot"
    LISTING = "listing"


class GoalRejectedEntity(BaseModel):
    kind: RejectedEntityKind
    value: str
    reason: str | None = None
    source_turn_id: str | None = None


class GoalTarget(BaseModel):
    category_id: str | None = None
    item_type: str | None = None
    brand: str | None = None
    model: str | None = None
    condition: str | None = None
    relation_required: ProductRelation = ProductRelation.PRODUCT
    canonical_description: str | None = None
    user_phrase: str | None = None


class GoalConstraint(BaseModel):
    constraint_id: str
    facet: str
    operator: str = "eq"
    value: Any
    unit: str | None = None
    hardness: ConstraintHardness = ConstraintHardness.HARD
    unknown_policy: UnknownPolicy = UnknownPolicy.BLOCK
    evidence_threshold: str = "observed"
    status: ConstraintStatus = ConstraintStatus.ACTIVE
    confidence: float = 1.0
    source_turn_id: str | None = None
    source_span: str | None = None
    supersedes_id: str | None = None


class RetrievalScope(BaseModel):
    markets_requested: list[str] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    merchants: list[str] = Field(default_factory=list)
    query_language: str | None = None
    delivery_destination: str | None = None


class ShoppingGoal(BaseModel):
    goal_version: int = 1
    legacy_belief_migrated: bool = False
    target: GoalTarget = Field(default_factory=GoalTarget)
    constraints: list[GoalConstraint] = Field(default_factory=list)
    preferences: list[GoalConstraint] = Field(default_factory=list)
    retrieval_scope: RetrievalScope = Field(default_factory=RetrievalScope)
    unresolved: list[str] = Field(default_factory=list)
    rejected_entities: list[GoalRejectedEntity] = Field(default_factory=list)

    @field_validator("rejected_entities", mode="before")
    @classmethod
    def migrate_legacy_rejections(cls, value):
        """Old rows stored excluded title terms as untyped strings."""
        return [
            {"kind": RejectedEntityKind.TERM, "value": item} if isinstance(item, str) else item
            for item in (value or [])
        ]

    def active_constraint(self, facet: str) -> GoalConstraint | None:
        for item in reversed(self.constraints):
            if item.facet == facet and item.status == ConstraintStatus.ACTIVE:
                return item
        return None

    def rejected_values(self, kind: RejectedEntityKind | str) -> list[str]:
        expected = RejectedEntityKind(kind)
        return [item.value for item in self.rejected_entities if item.kind == expected]
