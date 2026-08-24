from __future__ import annotations

import hashlib
import json
import re
from uuid import NAMESPACE_URL, uuid5

from ....domain.product_ontology import target_from_text
from ...dto.goal import RejectedEntityKind, ShoppingGoal
from ...dto.goal_ops import GoalOperation, GoalOperationKind
from ...dto.mission import MissionConstraints
from ..parse_intent import (
    canonicalize_spec_gates,
    normalize_exclude_terms,
    parse_budget,
    parse_markets,
    parse_preference,
)


def _target_payload(text: str) -> dict:
    lowered = text.lower()
    if re.search(r"\biphone\b", lowered):
        return {"item_type": "smartphone", "brand": "Apple", "relation_required": "product"}
    if re.search(r"\bsmart\s*phone\b|\bmobile phone\b|手机|智能手机", lowered):
        return {"item_type": "smartphone", "relation_required": "product"}
    if re.search(r"headphones?|headsets?|耳机|降噪", lowered):
        return {"item_type": "headphones", "relation_required": "product"}
    return {}


def compile_goal_operations(
    text: str,
    *,
    goal_version: int,
    source_turn_id: str | None = None,
    current_item_type: str | None = None,
) -> list[GoalOperation]:
    """高精度语义编译基线。LLM 后续只能补充，不得覆盖这些确定值。"""
    ops: list[GoalOperation] = []

    def add(kind: GoalOperationKind, payload: dict, span: str | None = None) -> None:
        position = len(ops)
        stable_turn = source_turn_id or hashlib.sha256(text.encode("utf-8")).hexdigest()
        fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        ops.append(
            GoalOperation(
                op_id=str(
                    uuid5(
                        NAMESPACE_URL,
                        f"interec-goal-op:{stable_turn}:{position}:{kind.value}:{fingerprint}",
                    )
                ),
                kind=kind,
                payload=payload,
                source_turn_id=source_turn_id,
                source_span=span,
                precondition_goal_version=goal_version,
            )
        )

    correction = bool(re.search(r"(?:不是|改成|改为|纠正|I mean|rather than)", text, re.I))
    if correction:
        add(
            GoalOperationKind.CORRECT_UNDERSTANDING,
            {"reason": "explicit_user_correction"},
        )
    target = target_from_text(text)
    brand_patterns = {
        "Apple": r"\bApple\b|苹果",
        "Sony": r"\bSony\b|索尼",
        "Bose": r"\bBose\b|博士耳机",
        "Samsung": r"\bSamsung\b|三星",
        "Google": r"\bGoogle\b|谷歌",
    }
    for brand, pattern in brand_patterns.items():
        if re.search(pattern, text, re.I):
            target["brand"] = brand
            break
    if target:
        add(GoalOperationKind.SET_TARGET, target)
    item_type = target.get("item_type") or current_item_type
    if item_type == "headphones" and re.search(
        r"降噪|noise[- ]?cancell?ing|active noise cancellation|\banc\b", text, re.I
    ):
        add(
            GoalOperationKind.UPSERT_CONSTRAINT,
            {
                "facet": "spec_gate:noise_cancelling",
                "operator": "matches",
                "value": {
                    "attr": "noise_cancelling",
                    "cues": [
                        "noise cancelling",
                        "noise canceling",
                        "active noise cancellation",
                        "anc",
                        "降噪",
                    ],
                    "required": True,
                },
                "hardness": "hard",
                "unknown_policy": "block",
            },
        )
    if item_type == "monitor":
        if re.search(r"\b4k\b|\buhd\b|2160|3840", text, re.I):
            add(
                GoalOperationKind.UPSERT_CONSTRAINT,
                {
                    "facet": "spec_gate:4k",
                    "operator": "matches",
                    "value": {
                        "attr": "4k",
                        "cues": ["4k", "2160", "uhd", "3840"],
                        "required": True,
                    },
                    "hardness": "hard",
                    "unknown_policy": "block",
                },
            )
        size = re.search(r"(\d{2,3})\s*(?:英寸|寸|inch|\")", text, re.I)
        if size:
            inches = size.group(1)
            add(
                GoalOperationKind.UPSERT_CONSTRAINT,
                {
                    "facet": "spec_gate:screen_size",
                    "operator": "matches",
                    "value": {
                        "attr": "screen_size",
                        "cues": [f"{inches} inch", f"{inches}-inch", f'{inches}"'],
                        "required": True,
                    },
                    "hardness": "hard",
                    "unknown_policy": "block",
                },
            )
    budget = parse_budget(text)
    if budget is not None:
        add(
            GoalOperationKind.UPSERT_CONSTRAINT,
            {
                "facet": "budget",
                "operator": "lte",
                "value": budget,
                "unit": "CNY",
                "hardness": "hard",
                "unknown_policy": "block",
            },
        )
    markets = parse_markets(text)
    if markets:
        add(GoalOperationKind.SET_RETRIEVAL_SCOPE, {"markets_requested": markets})
    preference = parse_preference(text)
    effective_item_type = item_type
    if preference and effective_item_type == "headphones":
        add(
            GoalOperationKind.ADD_PREFERENCE,
            {"facet": "ranking_preference", "value": preference},
        )
    platforms = [
        name
        for name, pattern in {
            "amazon": r"\bAmazon\b|亚马逊",
            "lazada": r"\bLazada\b",
            "shopee": r"\bShopee\b|虾皮",
            "bestbuy": r"\bBest\s*Buy\b",
        }.items()
        if re.search(pattern, text, re.I)
    ]
    if platforms:
        add(GoalOperationKind.SET_RETRIEVAL_SCOPE, {"platforms": platforms})
    if re.search(r"not (?:cases?|kits?|accessories)|不要.*(?:配件|保护壳|套件)", text, re.I):
        add(
            GoalOperationKind.UPSERT_CONSTRAINT,
            {
                "facet": "relation",
                "operator": "eq",
                "value": "product",
                "hardness": "hard",
                "unknown_policy": "block",
            },
        )
    if re.search(r"只看有货|仅看有货|must be in stock|in[- ]stock only", text, re.I):
        add(
            GoalOperationKind.UPSERT_CONSTRAINT,
            {
                "facet": "stock",
                "operator": "eq",
                "value": True,
                "hardness": "hard",
                "unknown_policy": "block",
                "evidence_threshold": "provider_top_level",
            },
        )
    if ops:
        add(GoalOperationKind.REQUEST_RESEARCH, {})
    return ops


def compile_constraint_operations(
    before: MissionConstraints,
    after: MissionConstraints,
    *,
    goal: ShoppingGoal,
    source_turn_id: str | None = None,
    origin: str = "deterministic",
) -> list[GoalOperation]:
    """Compile the legacy/API constraint delta into canonical Goal operations.

    MissionConstraints is an input adapter during migration, never a second
    writable aggregate.  All mutations still pass through the Goal reducer.
    """
    ops: list[GoalOperation] = []

    def add(kind: GoalOperationKind, payload: dict) -> None:
        fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        stable_turn = (
            source_turn_id
            or hashlib.sha256(
                f"{before.model_dump_json()}:{after.model_dump_json()}".encode()
            ).hexdigest()
        )
        ops.append(
            GoalOperation(
                op_id=str(
                    uuid5(
                        NAMESPACE_URL,
                        f"interec-constraint-op:{stable_turn}:{len(ops)}:{kind.value}:{fingerprint}",
                    )
                ),
                kind=kind,
                payload=payload,
                origin=origin,
                source_turn_id=source_turn_id,
                precondition_goal_version=goal.goal_version,
            )
        )

    if after.query != before.query:
        target_hint = target_from_text(after.query or "")
        canonical_description = target_hint.get("canonical_description") or after.query
        user_phrase = target_hint.get("user_phrase") or after.query
        add(
            GoalOperationKind.SET_TARGET,
            {
                "canonical_description": canonical_description,
                "user_phrase": user_phrase,
            },
        )
    if after.budget_cny != before.budget_cny:
        active = goal.active_constraint("budget")
        if after.budget_cny is None:
            if active is not None:
                add(GoalOperationKind.RETRACT_CONSTRAINT, {"constraint_id": active.constraint_id})
        else:
            add(
                GoalOperationKind.UPSERT_CONSTRAINT,
                {
                    "facet": "budget",
                    "operator": "lte",
                    "value": after.budget_cny,
                    "unit": "CNY",
                    "hardness": "hard",
                    "unknown_policy": "block",
                },
            )
    if after.markets != before.markets:
        add(GoalOperationKind.SET_RETRIEVAL_SCOPE, {"markets_requested": after.markets})
    if after.merchants != before.merchants:
        add(GoalOperationKind.SET_RETRIEVAL_SCOPE, {"merchants": after.merchants})
    if after.only_in_stock != before.only_in_stock:
        active = goal.active_constraint("stock")
        if after.only_in_stock:
            add(
                GoalOperationKind.UPSERT_CONSTRAINT,
                {
                    "facet": "stock",
                    "operator": "eq",
                    "value": True,
                    "hardness": "hard",
                    "unknown_policy": "block",
                    "evidence_threshold": "provider_top_level",
                },
            )
        elif active is not None:
            add(GoalOperationKind.RETRACT_CONSTRAINT, {"constraint_id": active.constraint_id})
    if after.preference != before.preference:
        add(
            GoalOperationKind.ADD_PREFERENCE,
            {"facet": "ranking_preference", "value": after.preference},
        )
    active_excludes = {
        str(item.value).casefold(): item
        for item in goal.constraints
        if item.status == "active" and item.facet.startswith("exclude_term:")
    }
    normalized_excludes = normalize_exclude_terms(after.excluded_terms)
    after_excludes = {term.casefold() for term in normalized_excludes}
    for term in normalized_excludes:
        if term.casefold() not in active_excludes:
            add(
                GoalOperationKind.UPSERT_CONSTRAINT,
                {
                    "facet": f"exclude_term:{term.casefold()}",
                    "operator": "not_contains",
                    "value": term,
                    "hardness": "hard",
                    "unknown_policy": "block",
                },
            )
    for term_key, constraint in active_excludes.items():
        if term_key not in after_excludes:
            add(
                GoalOperationKind.RETRACT_CONSTRAINT,
                {"constraint_id": constraint.constraint_id},
            )
    return ops


def compile_rejection_operations(
    *,
    goal: ShoppingGoal,
    source_turn_id: str | None = None,
    origin: str = "deterministic",
    snapshot_ids: list[str] | None = None,
    listing_keys: list[str] | None = None,
) -> list[GoalOperation]:
    """Promote candidate/listing rejections into the canonical Goal identity spaces."""
    ops: list[GoalOperation] = []
    stable_turn = source_turn_id or "goal-rejection-migration"

    def add(kind: RejectedEntityKind, value: str) -> None:
        value = value.strip()
        if not value or value in set(goal.rejected_values(kind)):
            return
        payload = {"entity_type": kind, "entity_id": value}
        fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        ops.append(
            GoalOperation(
                op_id=str(
                    uuid5(
                        NAMESPACE_URL,
                        f"interec-goal-rejection:{stable_turn}:{len(ops)}:{fingerprint}",
                    )
                ),
                kind=GoalOperationKind.REJECT_CANDIDATE,
                payload=payload,
                origin=origin,
                source_turn_id=source_turn_id,
                precondition_goal_version=goal.goal_version,
            )
        )

    for snapshot_id in snapshot_ids or []:
        add(RejectedEntityKind.SNAPSHOT, str(snapshot_id))
    for listing_key in listing_keys or []:
        add(RejectedEntityKind.LISTING, str(listing_key))
    return ops


def compile_preference_operations(
    *,
    goal_version: int,
    source_turn_id: str | None = None,
    origin: str = "model",
    soft_prefs: list | None = None,
    spec_gates: list | None = None,
    use_case: str | None = None,
    price_sensitivity: str | None = None,
) -> list[GoalOperation]:
    """Compile open preference memory into the canonical Goal aggregate."""
    ops: list[GoalOperation] = []
    stable_turn = source_turn_id or "goal-preference-migration"

    def add(facet: str, value) -> None:
        payload = {"facet": facet, "value": value}
        fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        ops.append(
            GoalOperation(
                op_id=str(
                    uuid5(
                        NAMESPACE_URL,
                        f"interec-goal-preference:{stable_turn}:{len(ops)}:{fingerprint}",
                    )
                ),
                kind=GoalOperationKind.ADD_PREFERENCE,
                payload=payload,
                origin=origin,
                source_turn_id=source_turn_id,
                precondition_goal_version=goal_version,
            )
        )

    def add_constraint(facet: str, value) -> None:
        payload = {
            "facet": facet,
            "operator": "matches",
            "value": value,
            "hardness": "hard",
            "unknown_policy": "block",
        }
        fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        ops.append(
            GoalOperation(
                op_id=str(
                    uuid5(
                        NAMESPACE_URL,
                        f"interec-goal-preference:{stable_turn}:{len(ops)}:{fingerprint}",
                    )
                ),
                kind=GoalOperationKind.UPSERT_CONSTRAINT,
                payload=payload,
                origin=origin,
                source_turn_id=source_turn_id,
                precondition_goal_version=goal_version,
            )
        )

    if use_case and use_case.strip():
        add("use_case", use_case.strip())
    if price_sensitivity:
        add("price_sensitivity", price_sensitivity)
    for item in soft_prefs or []:
        attr = str(getattr(item, "attr", "") or "").strip()
        if not attr:
            continue
        add(
            f"soft_preference:{attr}",
            {
                "attr": attr,
                "direction": str(getattr(item, "direction", "higher")),
                "status": str(getattr(item, "status", "active")),
                "cues": list(getattr(item, "cues", []) or []),
            },
        )
    for item in canonicalize_spec_gates(spec_gates or []):
        attr = str(getattr(item, "attr", "") or "").strip()
        if not attr:
            continue
        value = {
            "attr": attr,
            "cues": list(getattr(item, "cues", []) or []),
            "required": bool(getattr(item, "required", False)),
        }
        if value["required"]:
            add_constraint(f"spec_gate:{attr}", value)
        else:
            add(f"spec_gate:{attr}", value)
    return ops
