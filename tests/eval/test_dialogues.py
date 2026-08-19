"""离线对话评测：直接驱动运行时确定性图节点（classify→effects→merge→route），不访问外网。

控制反转后运行时唯一权威是 Agent 图；本评测跑真实节点而非平行实现，杜绝语义漂移。
无 dispatch 的话轮在异步架构里对应 talk/clarify 路由（不进 research/refilter/rerank）。"""
from __future__ import annotations

import json
from pathlib import Path

from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.dialogue import search_reuse_key
from tests.fakes import deterministic_turn

EVAL_PATH = Path(__file__).with_name("dialogues.json")

_NO_DISPATCH_ROUTES = {"talk", "clarify"}


def _cases() -> dict:
    return json.loads(EVAL_PATH.read_text(encoding="utf-8"))


def test_eval_has_thirty_plus_turns() -> None:
    payload = _cases()
    assert len(payload["turns"]) >= 30


def test_eval_dialogues_match_graph_pipeline() -> None:
    payload = _cases()
    failures: list[str] = []
    for case in payload["turns"]:
        constraints = MissionConstraints(
            query=case.get("query"),
            budget_cny=case.get("budget_cny"),
            markets=case.get("markets") or ["US"],
        )
        has_cache = bool(case.get("has_cache"))
        cache_payload = (
            {"ranked": payload["cache_ranked"], "reuse_key": search_reuse_key(constraints)}
            if has_cache
            else None
        )
        mission = ShoppingMission(owner_id="eval", title=case["id"], constraints=constraints)
        preview = deterministic_turn(mission, case["text"], cache_payload=cache_payload)
        act = preview.act
        expect = case["expect"]
        if act.kind.value != expect["kind"]:
            failures.append(f"{case['id']}: kind {act.kind.value} != {expect['kind']}")
            continue
        if "route" in expect and preview.route != expect["route"]:
            failures.append(f"{case['id']}: route {preview.route} != {expect['route']}")
        if "query" in expect and preview.constraints.query != expect["query"]:
            failures.append(f"{case['id']}: query {preview.constraints.query!r} != {expect['query']!r}")
        if "budget_cny" in expect and preview.constraints.budget_cny != expect["budget_cny"]:
            failures.append(
                f"{case['id']}: budget {preview.constraints.budget_cny} != {expect['budget_cny']}"
            )
        if "topic" in expect and (act.topic.value if act.topic else None) != expect["topic"]:
            failures.append(f"{case['id']}: topic {act.topic} != {expect['topic']}")
        if "ranks" in expect and act.referent_ranks != expect["ranks"]:
            failures.append(f"{case['id']}: ranks {act.referent_ranks} != {expect['ranks']}")
        if "exclude" in expect and act.exclude_terms != expect["exclude"]:
            failures.append(f"{case['id']}: exclude {act.exclude_terms} != {expect['exclude']}")
        if "preference" in expect and preview.constraints.preference != expect["preference"]:
            failures.append(
                f"{case['id']}: preference {preview.constraints.preference} != {expect['preference']}"
            )
        if "only_in_stock" in expect and preview.constraints.only_in_stock is not expect["only_in_stock"]:
            failures.append(f"{case['id']}: only_in_stock mismatch")
        if "markets" in expect and list(preview.constraints.markets) != expect["markets"]:
            failures.append(f"{case['id']}: markets {preview.constraints.markets} != {expect['markets']}")
        if expect.get("dispatch") is False and preview.route not in _NO_DISPATCH_ROUTES:
            failures.append(f"{case['id']}: expected talk/clarify, got {preview.route}")
        if expect.get("undo") and act.kind.value != "undo":
            failures.append(f"{case['id']}: expected undo kind")
        if expect.get("reject_focus") and not preview.belief.rejected_snapshot_ids:
            failures.append(f"{case['id']}: expected rejected snapshot")
        if expect.get("price_sensitivity") and preview.belief.price_sensitivity != expect["price_sensitivity"]:
            failures.append(
                f"{case['id']}: price_sensitivity {preview.belief.price_sensitivity} != {expect['price_sensitivity']}"
            )
        if expect.get("unsupported") and not any(
            item.attr == expect["unsupported"] and item.status == "unsupported"
            for item in preview.belief.soft
        ):
            failures.append(f"{case['id']}: expected unsupported {expect['unsupported']}")
    assert not failures, "评测失败:\n" + "\n".join(failures)
