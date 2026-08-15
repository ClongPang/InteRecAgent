from __future__ import annotations

import logging
from typing import Any

from app.api.context import get_thread_id
from app.harness.phase_machine import Phase, phase_machine
from app.observability.trace_ctx import get_langfuse_trace


logger = logging.getLogger(__name__)


async def try_phase_transition(context: dict[str, Any]) -> dict[str, Any] | None:
    """Move the conversation forward when reflect state satisfies a condition."""
    thread_id = _thread_id(context)
    current = phase_machine.get_current_phase(thread_id)
    transitioned = False
    signal: str | None = None

    if current == Phase.PLANNING and context.get("planner_output_ready"):
        signal = "planner_output_ready"
        transitioned = phase_machine.try_transition("planner_output_ready", thread_id)
        logger.info("Phase transition: PLANNING -> SEARCHING")
    elif current == Phase.SEARCHING:
        candidates_count = int(context.get("total_candidates") or 0)
        if candidates_count > 0:
            signal = "candidates_available"
            transitioned = phase_machine.try_transition("candidates_available", thread_id)
            logger.info(
                "Phase transition: SEARCHING -> COMPARING (%s candidates)",
                candidates_count,
            )
    elif current == Phase.COMPARING:
        picks_count = int(context.get("picks_count") or 0)
        if picks_count > 0:
            signal = "picks_ready"
            transitioned = phase_machine.try_transition("picks_ready", thread_id)
            logger.info(
                "Phase transition: COMPARING -> CONCLUDING (%s picks)",
                picks_count,
            )

    if transitioned:
        next_phase = phase_machine.get_current_phase(thread_id)
        _record_phase_transition(current, next_phase, signal)
        return {"phase": next_phase.value}
    return None


async def check_phase_rollback(context: dict[str, Any]) -> dict[str, Any] | None:
    """Rollback from COMPARING to SEARCHING when candidates cannot make progress."""
    thread_id = _thread_id(context)
    current = phase_machine.get_current_phase(thread_id)
    if current != Phase.COMPARING:
        return None

    no_progress_rounds = int(context.get("comparing_no_progress") or 0)
    if no_progress_rounds < 2:
        return None

    phase_machine.set_phase(Phase.SEARCHING, thread_id)
    logger.warning("Phase ROLLBACK: COMPARING -> SEARCHING (no progress)")
    _record_phase_transition(current, Phase.SEARCHING, "comparing_no_progress")

    messages = list(context.get("inject_messages") or [])
    messages.append({
        "role": "system",
        "content": (
            "当前候选集无法满足用户需求。已回退到搜索阶段。"
            "请尝试调整搜索条件（放宽预算/换品类/减少约束）。"
        ),
    })
    return {
        "inject_messages": messages,
        "comparing_no_progress": 0,
        "phase": Phase.SEARCHING.value,
        "phase_rollback": True,
    }


def _thread_id(context: dict[str, Any]) -> str | None:
    value = context.get("thread_id") or get_thread_id()
    return str(value) if value else None


def _record_phase_transition(
    current: Phase,
    next_phase: Phase,
    signal: str | None,
) -> None:
    trace = get_langfuse_trace()
    if not trace:
        return
    try:
        trace.event(
            name="phase_transition",
            input={
                "from": current.value,
                "to": next_phase.value,
                "trigger": signal,
            },
        )
    except Exception:
        return
