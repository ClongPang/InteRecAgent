from __future__ import annotations

import hashlib

from ....domain.models import DEFAULT_MARKETS
from ...dto.belief import PreferenceBelief, SoftPref, SpecGate
from ...dto.goal import (
    ConstraintStatus,
    GoalConstraint,
    GoalRejectedEntity,
    GoalTarget,
    RejectedEntityKind,
    RetrievalScope,
    ShoppingGoal,
    UnknownPolicy,
)
from ...dto.mission import MissionConstraints


def goal_from_constraint_view(
    constraints: MissionConstraints,
    *,
    version: int,
    current: ShoppingGoal | None = None,
) -> ShoppingGoal:
    """兼容投影：迁移期把旧约束收敛进 Goal，Goal 不反向依赖 query 语法。"""
    canonical_constraints = list(current.constraints if current else [])

    def sync_facet(facet: str, replacement: GoalConstraint | None) -> None:
        nonlocal canonical_constraints
        active = next(
            (
                item
                for item in reversed(canonical_constraints)
                if item.facet == facet and item.status == "active"
            ),
            None,
        )
        if replacement is not None and active is not None and active.value == replacement.value:
            return
        if active is not None:
            canonical_constraints = [
                item.model_copy(update={"status": ConstraintStatus.RETRACTED})
                if item.constraint_id == active.constraint_id
                else item
                for item in canonical_constraints
            ]
        if replacement is not None:
            canonical_constraints.append(replacement)

    sync_facet(
        "budget",
        GoalConstraint(
            constraint_id="legacy:budget_cny",
            facet="budget",
            operator="lte",
            value=constraints.budget_cny,
            unit="CNY",
            unknown_policy=UnknownPolicy.BLOCK,
        )
        if constraints.budget_cny is not None
        else None,
    )
    for term in constraints.excluded_terms:
        facet = f"exclude_term:{term.casefold()}"
        sync_facet(
            facet,
            GoalConstraint(
                constraint_id=f"legacy:{facet}",
                facet=facet,
                operator="not_contains",
                value=term,
                unknown_policy=UnknownPolicy.BLOCK,
            ),
        )
    sync_facet(
        "stock",
        GoalConstraint(
            constraint_id="legacy:stock",
            facet="stock",
            value=True,
            evidence_threshold="provider_top_level",
            unknown_policy=UnknownPolicy.BLOCK,
        )
        if constraints.only_in_stock
        else None,
    )
    target = current.target if current else GoalTarget(canonical_description=constraints.query)
    if target.canonical_description != constraints.query:
        target = target.model_copy(update={"canonical_description": constraints.query})
    return ShoppingGoal(
        goal_version=version,
        target=target,
        constraints=canonical_constraints,
        preferences=[
            GoalConstraint(
                constraint_id="legacy:ranking_preference",
                facet="ranking_preference",
                value=constraints.preference,
                hardness="soft",
                unknown_policy=UnknownPolicy.ALLOW,
            )
        ],
        retrieval_scope=RetrievalScope(
            markets_requested=list(constraints.markets),
            merchants=list(constraints.merchants),
            platforms=list(current.retrieval_scope.platforms if current else []),
            query_language=current.retrieval_scope.query_language if current else None,
            delivery_destination=current.retrieval_scope.delivery_destination if current else None,
        ),
        unresolved=list(current.unresolved if current else []),
        rejected_entities=list(current.rejected_entities if current else []),
    )


def ensure_goal_authority(
    goal: ShoppingGoal,
    constraints: MissionConstraints,
    *,
    version: int,
    belief: PreferenceBelief | None = None,
) -> ShoppingGoal:
    """One-time migration adapter for aggregates created before Goal V2."""
    has_state = bool(
        goal.target.canonical_description
        or goal.target.item_type
        or goal.constraints
        or goal.preferences
        or goal.retrieval_scope.markets_requested
        or goal.retrieval_scope.merchants
        or goal.rejected_entities
    )
    canonical = goal if has_state else goal_from_constraint_view(constraints, version=version, current=goal)
    canonical = _migrate_legacy_excluded_terms(canonical)
    if belief is None or canonical.legacy_belief_migrated:
        return canonical
    return promote_legacy_belief(canonical, belief).model_copy(
        update={"legacy_belief_migrated": True}
    )


def _migrate_legacy_excluded_terms(goal: ShoppingGoal) -> ShoppingGoal:
    """Move old untyped rejected strings to retractable hard constraints."""
    legacy_terms = goal.rejected_values(RejectedEntityKind.TERM)
    if not legacy_terms:
        return goal
    constraints = list(goal.constraints)
    active_facets = {item.facet for item in constraints if item.status == ConstraintStatus.ACTIVE}
    for term in legacy_terms:
        facet = f"exclude_term:{term.casefold()}"
        if facet in active_facets:
            continue
        digest = hashlib.sha256(term.encode("utf-8")).hexdigest()[:16]
        constraints.append(
            GoalConstraint(
                constraint_id=f"legacy:exclude:{digest}",
                facet=facet,
                operator="not_contains",
                value=term,
                unknown_policy=UnknownPolicy.BLOCK,
            )
        )
        active_facets.add(facet)
    return goal.model_copy(
        update={
            "constraints": constraints,
            "rejected_entities": [
                item for item in goal.rejected_entities if item.kind != RejectedEntityKind.TERM
            ],
        }
    )


def promote_legacy_belief(goal: ShoppingGoal, belief: PreferenceBelief) -> ShoppingGoal:
    """One-time, version-neutral migration of legacy decision memory into Goal.

    This does not represent a new user decision, so it preserves goal_version.
    Subsequent writes persist the canonical representation and Belief becomes a
    compatibility/read-model projection only.
    """
    constraints = list(goal.constraints)
    preferences = list(goal.preferences)
    rejected = list(goal.rejected_entities)
    active_constraint_facets = {
        item.facet for item in constraints if item.status == ConstraintStatus.ACTIVE
    }
    active_preference_facets = {
        item.facet for item in preferences if item.status == ConstraintStatus.ACTIVE
    }

    def add_preference(facet: str, value) -> None:
        if facet in active_preference_facets:
            return
        preferences.append(
            GoalConstraint(
                constraint_id=f"legacy-belief:{facet}",
                facet=facet,
                value=value,
                hardness="soft",
                unknown_policy=UnknownPolicy.ALLOW,
            )
        )
        active_preference_facets.add(facet)

    if belief.use_case:
        add_preference("use_case", belief.use_case)
    if belief.price_sensitivity:
        add_preference("price_sensitivity", belief.price_sensitivity)
    for soft_pref in belief.soft:
        add_preference(
            f"soft_preference:{soft_pref.attr}",
            {
                "attr": soft_pref.attr,
                "direction": soft_pref.direction,
                "status": soft_pref.status,
                "cues": list(soft_pref.cues),
            },
        )
    for gate in belief.spec_gates:
        facet = f"spec_gate:{gate.attr}"
        value = {"attr": gate.attr, "cues": list(gate.cues), "required": gate.required}
        if gate.required:
            if facet not in active_constraint_facets:
                constraints.append(
                    GoalConstraint(
                        constraint_id=f"legacy-belief:{facet}",
                        facet=facet,
                        operator="matches",
                        value=value,
                        hardness="hard",
                        unknown_policy=UnknownPolicy.BLOCK,
                    )
                )
                active_constraint_facets.add(facet)
        else:
            add_preference(facet, value)

    reasons = {
        item.snapshot_id: item.reason
        for item in belief.critiques
        if item.snapshot_id and item.reason
    }

    def add_rejection(kind: RejectedEntityKind, value: str) -> None:
        if value and not any(item.kind == kind and item.value == value for item in rejected):
            rejected.append(
                GoalRejectedEntity(
                    kind=kind,
                    value=value,
                    reason=reasons.get(value) if kind == RejectedEntityKind.SNAPSHOT else None,
                )
            )

    for snapshot_id in belief.rejected_snapshot_ids:
        add_rejection(RejectedEntityKind.SNAPSHOT, snapshot_id)
    for listing_key in belief.rejected_listing_keys:
        add_rejection(RejectedEntityKind.LISTING, listing_key)
    return goal.model_copy(
        update={
            "constraints": constraints,
            "preferences": preferences,
            "rejected_entities": rejected,
        }
    )


def constraint_view_from_goal(
    goal: ShoppingGoal,
    *,
    fallback: MissionConstraints | None = None,
) -> MissionConstraints:
    """Read-only compatibility projection. ShoppingGoal remains the stored authority."""
    fallback = fallback or MissionConstraints()
    budget = goal.active_constraint("budget")
    stock = goal.active_constraint("stock")
    preference = next(
        (
            item
            for item in reversed(goal.preferences)
            if item.facet == "ranking_preference" and item.status == "active"
        ),
        None,
    )
    return MissionConstraints(
        query=goal.target.canonical_description or fallback.query,
        budget_cny=float(budget.value) if budget is not None else None,
        markets=list(goal.retrieval_scope.markets_requested or DEFAULT_MARKETS),
        preference=str(preference.value) if preference is not None else fallback.preference,
        only_in_stock=bool(stock.value) if stock is not None else False,
        excluded_terms=[
            str(item.value)
            for item in goal.constraints
            if item.status == ConstraintStatus.ACTIVE and item.facet.startswith("exclude_term:")
        ],
        merchants=list(goal.retrieval_scope.merchants),
    )


def belief_view_from_goal(
    goal: ShoppingGoal,
    *,
    fallback: PreferenceBelief | None = None,
) -> PreferenceBelief:
    """Compatibility projection; no recommendation decision may read it as authority."""
    fallback = fallback or PreferenceBelief()
    active_preferences = {
        item.facet: item for item in goal.preferences if item.status == ConstraintStatus.ACTIVE
    }
    soft = [
        SoftPref.model_validate(item.value)
        for facet, item in active_preferences.items()
        if facet.startswith("soft_preference:") and isinstance(item.value, dict)
    ]
    gates = [
        SpecGate.model_validate(item.value)
        for item in goal.constraints
        if item.status == ConstraintStatus.ACTIVE
        and item.facet.startswith("spec_gate:")
        and isinstance(item.value, dict)
    ]
    gates.extend(
        SpecGate.model_validate(item.value)
        for facet, item in active_preferences.items()
        if facet.startswith("spec_gate:") and isinstance(item.value, dict)
    )
    return fallback.model_copy(
        update={
            "use_case": (
                str(active_preferences["use_case"].value)
                if "use_case" in active_preferences
                else None
            ),
            "price_sensitivity": (
                str(active_preferences["price_sensitivity"].value)
                if "price_sensitivity" in active_preferences
                else None
            ),
            "soft": soft,
            "spec_gates": gates,
            "rejected_snapshot_ids": goal.rejected_values(RejectedEntityKind.SNAPSHOT),
            "rejected_listing_keys": goal.rejected_values(RejectedEntityKind.LISTING),
        }
    )
