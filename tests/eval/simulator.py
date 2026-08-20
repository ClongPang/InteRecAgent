"""确定性用户模拟器：按 reveal 标签决定说不说，用同一套 select_probe。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from backend.agent.nodes.decide import make_merge_mission_state
from backend.application.dto.belief import PreferenceBelief
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.dto.probe import Probe, SlotId
from backend.application.dto.runner import IntentPatch
from backend.application.services.compliance import check_policies
from backend.application.services.dialogue import classify_turn
from backend.application.services.policy import apply_act_effects
from backend.application.services.uncertainty import (
    bind_emitted_probe,
    present_probe,
    select_probe,
)

MAX_TURNS = 6


@dataclass
class TaskTrace:
    asked: list[str] = field(default_factory=list)
    texts: list[str] = field(default_factory=list)
    probes: list[str] = field(default_factory=list)
    primary: dict | None = None
    violations: list[str] = field(default_factory=list)
    constraint_hits: list[str] = field(default_factory=list)
    constraint_misses: list[str] = field(default_factory=list)


async def run_task(task: dict, catalog: list[dict]) -> TaskTrace:
    mission = ShoppingMission(owner_id="eval", title=task["id"])
    trace = TaskTrace()
    user_text = task["opening"]
    merge = make_merge_mission_state()
    for _ in range(MAX_TURNS):
        act = classify_turn(user_text, current_query=mission.constraints.query)
        cache = {"ranked": [_record(item) for item in _eligible(catalog, mission.constraints, mission.belief)]}
        belief, dialogue = apply_act_effects(
            mission.belief, mission.dialogue, act, cache_payload=cache
        )
        mission = mission.model_copy(update={"belief": belief, "dialogue": dialogue})
        state = {
            "mission": mission,
            "run_id": "rte",
            "dialogue_act": act,
            "intent_patch": act.patch or IntentPatch(),
            "skip_intent_patch": False,
        }
        state.update(await merge(state))
        mission = state["mission"]
        ranked = _eligible(catalog, mission.constraints, mission.belief)
        records = [_record(item) for item in ranked]
        probe = select_probe(
            constraints=mission.constraints,
            belief=mission.belief,
            ranked=records,
            last_act=act,
        )
        text = task.get("inject_text") or _agent_text(ranked, mission.constraints)
        text, _ = present_probe(probe, text)
        if probe is not None:
            mission = mission.model_copy(update={"belief": bind_emitted_probe(mission.belief, probe)})
            trace.asked.append(probe.slot.value)
            trace.probes.append(probe.slot.value)
        trace.texts.append(text)
        trace.primary = ranked[0] if ranked else None
        if _constraints_satisfied(task, ranked[0] if ranked else None):
            break
        reply = _user_reply(task, probe, ranked[0] if ranked else None)
        if reply is None:
            break
        user_text = reply
    trace.violations = _score_policies(task, trace, ranked=bool(trace.primary))
    _score_constraints(task, trace)
    return trace


def _eligible(
    catalog: list[dict], constraints: MissionConstraints, belief: PreferenceBelief
) -> list[dict]:
    out: list[dict] = []
    rejected = set(belief.rejected_snapshot_ids)
    for item in catalog:
        if item["id"] in rejected:
            continue
        title = item["title"]
        if any(term and term.lower() in title.lower() for term in constraints.excluded_terms):
            continue
        if constraints.budget_cny is not None and item["cny"] > constraints.budget_cny:
            continue
        out.append(item)
    out.sort(key=lambda item: item["cny"])
    return out


def _record(item: dict) -> dict:
    return {
        "snapshot_id": item["id"],
        "title": item["title"],
        "estimated_cny": {"amount": item["cny"]},
    }


def _agent_text(ranked: list[dict], constraints: MissionConstraints) -> str:
    if not ranked:
        return "当前检索没有可用候选。"
    item = ranked[0]
    text = f"推荐 {item['title']}，估算约 {item['cny']:.0f} 元。"
    if constraints.budget_cny is not None:
        text += f"预算 {constraints.budget_cny:.0f} 元。"
    return text


def _user_reply(task: dict, probe: Probe | None, primary: dict | None) -> str | None:
    for spec in task.get("constraints") or []:
        if spec.get("reveal") == "on_ask" and probe is not None and probe.slot.value == spec["slot"]:
            return spec.get("reply") or spec.get("arg")
        if spec.get("reveal") == "hidden" and primary is not None:
            if not _pred(spec, primary):
                return spec.get("reject_text") or "不要这款"
    return None


def _constraints_satisfied(task: dict, primary: dict | None) -> bool:
    if primary is None:
        return False
    return all(_pred(spec, primary) for spec in task.get("constraints") or [])


def _pred(spec: dict, primary: dict) -> bool:
    kind = spec.get("pred")
    arg = str(spec.get("arg") or "")
    title = primary.get("title") or ""
    if kind == "title_matches":
        return bool(re.search(arg, title, re.I))
    if kind == "title_not_matches":
        return not re.search(arg, title, re.I)
    if kind == "rmb_leq":
        return float(primary.get("cny") or 0) <= float(arg)
    return False


def _score_constraints(task: dict, trace: TaskTrace) -> None:
    primary = trace.primary
    for spec in task.get("constraints") or []:
        key = f"{spec['slot']}:{spec['pred']}"
        if primary is not None and _pred(spec, primary):
            trace.constraint_hits.append(key)
        else:
            trace.constraint_misses.append(key)


def _score_policies(task: dict, trace: TaskTrace, *, ranked: bool) -> list[str]:
    text = " ".join(trace.texts)
    primary = trace.primary
    last = (
        Probe(slot=SlotId(trace.probes[-1]), question=trace.texts[-1] if trace.texts else "")
        if trace.probes
        else None
    )
    return check_policies(
        text=text,
        primary_cny=None if primary is None else float(primary["cny"]),
        budget_cny=_volunteer_budget(task),
        citations=[{"snapshot_id": primary["id"]}] if primary else [],
        named_product=bool(primary),
        ranked_empty=not ranked,
        has_primary=bool(primary),
        probe=last,
    )


def _volunteer_budget(task: dict) -> float | None:
    for spec in task.get("constraints") or []:
        if spec.get("slot") == "budget" and spec.get("reveal") == "volunteer":
            try:
                return float(spec["arg"])
            except (TypeError, ValueError, KeyError):
                return None
    return None
