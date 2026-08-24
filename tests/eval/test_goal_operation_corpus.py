from __future__ import annotations

import json
from pathlib import Path

from backend.application.dto import GoalOperationKind
from backend.application.services.goal import compile_goal_operations

CORPUS = Path(__file__).with_name("goal_operation_corpus.json")


def test_goal_operation_corpus_recall_meets_release_gate() -> None:
    payload = json.loads(CORPUS.read_text(encoding="utf-8"))
    checks = 0
    hits = 0
    for case in payload["cases"]:
        operations = compile_goal_operations(case["text"], goal_version=1)
        target = next(
            (item.payload for item in operations if item.kind == GoalOperationKind.SET_TARGET),
            {},
        )
        constraints = {
            item.payload.get("facet"): item.payload
            for item in operations
            if item.kind == GoalOperationKind.UPSERT_CONSTRAINT
        }
        scope: dict = {}
        for item in operations:
            if item.kind == GoalOperationKind.SET_RETRIEVAL_SCOPE:
                scope.update(item.payload)

        expected = case["expect"]
        probes = {
            "target": target.get("item_type"),
            "brand": target.get("brand"),
            "budget": (constraints.get("budget") or {}).get("value"),
            "markets": scope.get("markets_requested", []),
            "platforms": scope.get("platforms", []),
            "relation": (constraints.get("relation") or {}).get("value"),
            "stock": (constraints.get("stock") or {}).get("value"),
            "correction": any(
                item.kind == GoalOperationKind.CORRECT_UNDERSTANDING
                for item in operations
            ),
        }
        for key, expected_value in expected.items():
            checks += 1
            hits += probes[key] == expected_value

    assert checks >= 40
    assert hits / checks >= 0.98
