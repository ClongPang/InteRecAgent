"""对正在跑的后端做一次真实 SSE / token / 快照联调。"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid

import httpx

TERMINAL = {
    "recommendation.ready",
    "run.degraded",
    "clarification.required",
    "run.failed",
    "run.cancelled",
}


def _print_event(kind: str, name: str, payload: dict, elapsed: float) -> None:
    summary = {
        k: payload.get(k)
        for k in (
            "run_id",
            "query",
            "markets",
            "count",
            "found",
            "failed_markets",
            "converted",
            "failed",
            "text",
            "question",
            "delta",
        )
        if payload.get(k) not in (None, "", [], {})
    }
    text = json.dumps(summary, ensure_ascii=False)
    if len(text) > 220:
        text = text[:217] + "..."
    print(f"  [{elapsed:6.1f}s] {kind:5} {name:28} {text}")


async def _read_sse(resp: httpx.Response, sink: list[tuple[str, dict]], started: float, label: str):
    event_name = "message"
    data = ""
    async for line in resp.aiter_lines():
        if line.startswith("id:"):
            continue
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
            continue
        if line.startswith("data:"):
            data += line.split(":", 1)[1].strip()
            continue
        if line.strip() == "":
            if not data:
                event_name = "message"
                continue
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                payload = {"raw": data}
            sink.append((event_name, payload if isinstance(payload, dict) else {"raw": payload}))
            _print_event(label, event_name, sink[-1][1], time.monotonic() - started)
            if event_name in TERMINAL or event_name in {
                "agent.message.completed",
                "agent.message.aborted",
            }:
                return
            event_name = "message"
            data = ""


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8002")
    parser.add_argument("--text", default="通勤降噪耳机，预算 4000 元")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    owner = str(uuid.uuid4())
    headers = {"X-Anonymous-User-ID": owner, "Content-Type": "application/json"}
    started = time.monotonic()
    print(f"== live stream smoke ==\nbase={args.base}\nowner={owner}\ntext={args.text!r}")

    async with httpx.AsyncClient(base_url=args.base, timeout=args.timeout) as client:
        live = await client.get("/api/v1/health/live")
        ready = await client.get("/api/v1/health/ready")
        print(f"health live={live.status_code} {live.text} ready={ready.status_code} {ready.text}")
        if live.status_code != 200 or ready.status_code != 200:
            return 1

        created = await client.post("/api/v1/missions", json={"text": args.text}, headers=headers)
        print(f"create {created.status_code} elapsed={time.monotonic() - started:.1f}s")
        if created.status_code != 201:
            print(created.text[:800])
            return 1
        body = created.json()
        mission_id = body["mission"]["id"]
        run_id = body["run_id"]
        print(f"mission={mission_id} run={run_id} stage={body['mission']['stage']} phase={body['mission']['turn_phase']}")

        events: list[tuple[str, dict]] = []
        texts: list[tuple[str, dict]] = []

        async def follow_events():
            async with client.stream(
                "GET",
                f"/api/v1/missions/{mission_id}/events?after=0",
                headers=headers,
            ) as resp:
                print(f"events status={resp.status_code}")
                if resp.status_code != 200:
                    print(await resp.aread())
                    return
                await _read_sse(resp, events, started, "event")

        async def follow_text():
            async with client.stream(
                "GET",
                f"/api/v1/missions/{mission_id}/runs/{run_id}/text",
                headers=headers,
            ) as resp:
                print(f"text   status={resp.status_code}")
                if resp.status_code != 200:
                    print(await resp.aread())
                    return
                await _read_sse(resp, texts, started, "text")

        try:
            await asyncio.wait_for(
                asyncio.gather(follow_events(), follow_text()),
                timeout=args.timeout,
            )
        except TimeoutError:
            print(f"!! timeout after {args.timeout:.0f}s")

        mission = await client.get(f"/api/v1/missions/{mission_id}", headers=headers)
        cands = await client.get(f"/api/v1/missions/{mission_id}/candidates", headers=headers)
        thread = await client.get(f"/api/v1/missions/{mission_id}/thread", headers=headers)
        rec = await client.get(f"/api/v1/missions/{mission_id}/recommendation", headers=headers)
        mv = mission.json()
        ranked = (cands.json().get("ranked") or []) if cands.status_code == 200 else []
        messages = (thread.json().get("messages") or []) if thread.status_code == 200 else []
        print("-- snapshot --")
        print(
            f"stage={mv.get('stage')} phase={mv.get('turn_phase')} "
            f"version={mv.get('constraints_version')} candidates={len(ranked)} "
            f"thread={len(messages)} rec={rec.status_code}"
        )
        if ranked:
            top = ranked[0]
            print(
                f"top={top.get('title')} market={top.get('market')} "
                f"cny={(top.get('estimated_cny') or {}).get('amount')}"
            )
        agent = [m for m in messages if m.get("kind") in {"agent", "clarification", "recommendation"}]
        if agent:
            print(f"agent={agent[-1].get('text', '')[:180]}")

        names = [name for name, _ in events]
        print("-- events --")
        print(" -> ".join(names) if names else "(none)")
        ok = bool(TERMINAL.intersection(names)) and mission.status_code == 200
        print(f"elapsed={time.monotonic() - started:.1f}s result={'PASS' if ok else 'FAIL'}")
        return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
