"""离线对话评测：确定性分类 + 政策路由，不访问外网。"""
from __future__ import annotations

import json
from pathlib import Path

from backend.application.dto.dialogue import TurnCommand
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.dialogue import classify_turn, search_reuse_key
from backend.application.services.policy import DialoguePolicy, TurnInput

EVAL_PATH = Path(__file__).with_name("dialogues.json")


def _cases() -> dict:
    return json.loads(EVAL_PATH.read_text(encoding="utf-8"))


def test_eval_has_thirty_plus_turns() -> None:
    payload = _cases()
    assert len(payload["turns"]) >= 30


def test_eval_dialogues_match_policy() -> None:
    payload = _cases()
    cache = {"ranked": payload["cache_ranked"], "reuse_key": None}
    failures: list[str] = []
    for case in payload["turns"]:
        constraints = MissionConstraints(
            query=case.get("query"),
            budget_cny=case.get("budget_cny"),
            markets=case.get("markets") or ["US"],
        )
        cache["reuse_key"] = search_reuse_key(constraints)
        has_cache = bool(case.get("has_cache"))
        mission = ShoppingMission(owner_id="eval", title=case["id"], constraints=constraints)
        act = classify_turn(case["text"], current_query=constraints.query)
        decision = DialoguePolicy().decide(
            mission=mission,
            turn=TurnInput(command=TurnCommand.MESSAGE, text=case["text"]),
            has_cache=has_cache,
            cache_reuse_key=cache["reuse_key"] if has_cache else None,
            cache_payload=cache if has_cache else None,
        )
        expect = case["expect"]
        if act.kind.value != expect["kind"]:
            failures.append(f"{case['id']}: kind {act.kind.value} != {expect['kind']}")
            continue
        if "route" in expect and decision.route.value != expect["route"]:
            failures.append(f"{case['id']}: route {decision.route.value} != {expect['route']}")
        if "query" in expect and decision.constraints.query != expect["query"]:
            failures.append(f"{case['id']}: query {decision.constraints.query!r} != {expect['query']!r}")
        if "budget_cny" in expect and decision.constraints.budget_cny != expect["budget_cny"]:
            failures.append(
                f"{case['id']}: budget {decision.constraints.budget_cny} != {expect['budget_cny']}"
            )
        if "topic" in expect and (act.topic.value if act.topic else None) != expect["topic"]:
            failures.append(f"{case['id']}: topic {act.topic} != {expect['topic']}")
        if "ranks" in expect and act.referent_ranks != expect["ranks"]:
            failures.append(f"{case['id']}: ranks {act.referent_ranks} != {expect['ranks']}")
        if "exclude" in expect and act.exclude_terms != expect["exclude"]:
            failures.append(f"{case['id']}: exclude {act.exclude_terms} != {expect['exclude']}")
        if "preference" in expect and decision.constraints.preference != expect["preference"]:
            failures.append(
                f"{case['id']}: preference {decision.constraints.preference} != {expect['preference']}"
            )
        if "only_in_stock" in expect and decision.constraints.only_in_stock is not expect["only_in_stock"]:
            failures.append(f"{case['id']}: only_in_stock mismatch")
        if "markets" in expect and list(decision.constraints.markets) != expect["markets"]:
            failures.append(f"{case['id']}: markets {decision.constraints.markets} != {expect['markets']}")
        if expect.get("dispatch") is False and decision.dispatch:
            failures.append(f"{case['id']}: expected no dispatch")
        if expect.get("undo") and not decision.undo:
            failures.append(f"{case['id']}: expected undo")
        if expect.get("reject_focus") and not decision.belief.rejected_snapshot_ids:
            failures.append(f"{case['id']}: expected rejected snapshot")
        if expect.get("price_sensitivity") and decision.belief.price_sensitivity != expect["price_sensitivity"]:
            failures.append(
                f"{case['id']}: price_sensitivity {decision.belief.price_sensitivity} != {expect['price_sensitivity']}"
            )
        if expect.get("unsupported") and not any(
            item.attr == expect["unsupported"] and item.status == "unsupported"
            for item in decision.belief.soft
        ):
            failures.append(f"{case['id']}: expected unsupported {expect['unsupported']}")
    assert not failures, "评测失败:\n" + "\n".join(failures)
