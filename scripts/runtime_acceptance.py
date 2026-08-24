"""Strict black-box acceptance against a running InteRecAgent API."""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

import httpx

TERMINAL_STAGES = {"ready", "degraded", "clarifying", "failed"}
SUCCESS_STAGES = {"ready", "degraded"}


@dataclass(frozen=True)
class Scenario:
    owner_id: str
    text: str
    forbidden_title_terms: tuple[str, ...]
    expected_stage: str = "ready_or_degraded"
    allow_empty: bool = False
    requires_confirmed_stock: bool = False
    required_title_term_groups: tuple[tuple[str, ...], ...] = ()


SCENARIOS = (
    Scenario(
        "e2e10000-0000-4000-8000-000000000001",
        "通勤降噪耳机，预算 4000 元，优先续航",
        ("cable", "case", "earpad", "replacement pad"),
        required_title_term_groups=(
            ("anc", "noise cancelling", "noise canceling", "active noise cancellation", "降噪"),
        ),
    ),
    Scenario(
        "e2e10000-0000-4000-8000-000000000002",
        "27 英寸 4K 显示器，预算 5000 元，用于办公",
        ("monitor arm", "monitor stand", "cable", "screen protector"),
        "clarifying",
    ),
    Scenario(
        "e2e10000-0000-4000-8000-000000000003",
        "iPhone 15 Pro 手机，预算 9000 元，只看有货",
        ("case", "cable", "charger", "screen protector"),
        "ready_or_degraded",
        True,
        True,
    ),
    Scenario(
        "e2e10000-0000-4000-8000-000000000004",
        "MacBook Air 笔记本，预算 9000 元",
        ("case", "cable", "charger", "screen protector"),
        "clarifying",
    ),
)


def headers(owner_id: str) -> dict[str, str]:
    return {"X-Anonymous-User-ID": owner_id}


async def wait_terminal(
    client: httpx.AsyncClient,
    owner_id: str,
    mission_id: str,
    timeout: float,
) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        response = await client.get(f"/api/v1/missions/{mission_id}", headers=headers(owner_id))
        response.raise_for_status()
        mission = response.json()
        if mission["stage"] in TERMINAL_STAGES and mission["turn_phase"] == "idle":
            return mission
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError(f"mission {mission_id} timed out at {mission['stage']}")
        await asyncio.sleep(0.5)


async def run_scenario(client: httpx.AsyncClient, scenario: Scenario, timeout: float) -> dict:
    created = await client.post(
        "/api/v1/missions",
        headers=headers(scenario.owner_id),
        json={"text": scenario.text},
    )
    assert created.status_code == 201, created.text
    created_body = created.json()
    mission_id = created_body["mission"]["id"]
    mission = await wait_terminal(client, scenario.owner_id, mission_id, timeout)
    if scenario.expected_stage == "clarifying":
        assert mission["stage"] == "clarifying", mission
    else:
        assert mission["stage"] in SUCCESS_STAGES, mission
    assert mission["turn_phase"] == "idle", mission
    assert mission["constraints_version"] >= 2, mission
    if scenario.requires_confirmed_stock:
        assert mission["constraints"]["only_in_stock"] is True, mission

    if scenario.expected_stage == "clarifying":
        thread_response = await client.get(
            f"/api/v1/missions/{mission_id}/thread",
            headers=headers(scenario.owner_id),
        )
        thread_response.raise_for_status()
        text = "\n".join(
            str(message.get("text") or "")
            for message in thread_response.json()["messages"]
            if message.get("kind") != "user"
        )
        assert "尚未开放" in text
        return {
            "owner_id": scenario.owner_id,
            "mission_id": mission_id,
            "stage": mission["stage"],
            "constraints_version": mission["constraints_version"],
            "candidate_count": 0,
            "primary": None,
            "warnings": mission["warnings"],
        }

    candidates_response = await client.get(
        f"/api/v1/missions/{mission_id}/candidates",
        headers=headers(scenario.owner_id),
    )
    candidates_response.raise_for_status()
    candidates = candidates_response.json()["ranked"]
    if not candidates and scenario.allow_empty:
        thread_response = await client.get(
            f"/api/v1/missions/{mission_id}/thread",
            headers=headers(scenario.owner_id),
        )
        thread_response.raise_for_status()
        text = "\n".join(
            str(message.get("text") or "")
            for message in thread_response.json()["messages"]
            if message.get("kind") != "user"
        )
        assert "不会用未知或不合格商品补位" in text
        return {
            "owner_id": scenario.owner_id,
            "mission_id": mission_id,
            "stage": mission["stage"],
            "constraints_version": mission["constraints_version"],
            "candidate_count": 0,
            "primary": None,
            "warnings": mission["warnings"],
        }
    assert candidates, f"{scenario.text!r} returned no candidates"
    snapshot_ids = {item["snapshot_id"] for item in candidates}
    assert len(snapshot_ids) == len(candidates), "duplicate canonical snapshots"
    assert all(item["source"] == "buywhere" for item in candidates)
    assert all("source_product_id" not in item for item in candidates)
    assert all(item["merchant_url"].startswith("https://") for item in candidates)
    assert all(item["native_price"]["amount"] > 0 for item in candidates)
    if scenario.requires_confirmed_stock:
        assert all(item["availability"] in {"in_stock", "limited"} for item in candidates)
        assert all(item["stock_source"] == "top_level" for item in candidates)
    for item in candidates:
        lowered = item["title"].lower()
        assert not any(term in lowered for term in scenario.forbidden_title_terms), item
        for terms in scenario.required_title_term_groups:
            assert any(term in lowered for term in terms), item

    recommendation_response = await client.get(
        f"/api/v1/missions/{mission_id}/recommendation",
        headers=headers(scenario.owner_id),
    )
    recommendation_response.raise_for_status()
    recommendation = recommendation_response.json()
    assert recommendation["primary"]["snapshot_id"] in snapshot_ids
    assert set(recommendation["cited_evidence_ids"]).issubset(snapshot_ids)

    thread_response = await client.get(
        f"/api/v1/missions/{mission_id}/thread",
        headers=headers(scenario.owner_id),
    )
    thread_response.raise_for_status()
    messages = thread_response.json()["messages"]
    agent_text = "\n".join(
        str(message.get("text") or "") for message in messages if message.get("kind") != "user"
    )
    assert agent_text.strip(), "no agent response was projected"
    return {
        "owner_id": scenario.owner_id,
        "mission_id": mission_id,
        "stage": mission["stage"],
        "constraints_version": mission["constraints_version"],
        "candidate_count": len(candidates),
        "primary": recommendation["primary"]["title"],
        "warnings": mission["warnings"],
    }


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    async with httpx.AsyncClient(base_url=args.base, timeout=args.timeout) as client:
        live, ready = await asyncio.gather(
            client.get("/api/v1/health/live"),
            client.get("/api/v1/health/ready"),
        )
        assert live.status_code == ready.status_code == 200
        results = await asyncio.gather(
            *(run_scenario(client, scenario, args.timeout) for scenario in SCENARIOS)
        )

        for result in results:
            foreign_owner = next(
                scenario.owner_id
                for scenario in SCENARIOS
                if scenario.owner_id != result["owner_id"]
            )
            response = await client.get(
                f"/api/v1/missions/{result['mission_id']}",
                headers=headers(foreign_owner),
            )
            assert response.status_code == 404, "cross-user mission access was not hidden"

        for scenario in SCENARIOS:
            response = await client.get(
                "/api/v1/missions?limit=20&offset=0", headers=headers(scenario.owner_id)
            )
            response.raise_for_status()
            owned_ids = {item["id"] for item in response.json()["missions"]}
            expected = next(
                result["mission_id"]
                for result in results
                if result["owner_id"] == scenario.owner_id
            )
            assert expected in owned_ids
            assert not any(
                result["mission_id"] in owned_ids
                for result in results
                if result["owner_id"] != scenario.owner_id
            )

    report = {"status": "PASS", "base": args.base, "scenarios": results}
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
