from __future__ import annotations

from contextvars import ContextVar
from enum import Enum
from typing import Any

from app.api.context import get_thread_id


class Phase(Enum):
    PLANNING = "planning"
    SEARCHING = "searching"
    COMPARING = "comparing"
    CONCLUDING = "concluding"


PHASE_TOOLS: dict[Phase, set[str]] = {
    Phase.PLANNING: {
        "planner",
        "chat_fallback",
        "category_insight",
        "web_search",
    },
    Phase.SEARCHING: {
        "item_search",
        "dispatch_tool",
        "web_search",
        "category_insight",
        "chat_fallback",
    },
    Phase.COMPARING: {
        "price_compare",
        "shipping_calc",
        "item_picker",
        "chat_fallback",
    },
    Phase.CONCLUDING: {
        "shopping_summary",
        "chat_fallback",
    },
}

TRANSITION_CONDITIONS: dict[Phase, dict[str, Phase]] = {
    Phase.PLANNING: {
        "planner_output_ready": Phase.SEARCHING,
    },
    Phase.SEARCHING: {
        "candidates_available": Phase.COMPARING,
    },
    Phase.COMPARING: {
        "picks_ready": Phase.CONCLUDING,
    },
    Phase.CONCLUDING: {},
}

_phase_var: ContextVar[Phase] = ContextVar("agent_phase", default=Phase.PLANNING)
_phase_by_thread: dict[str, Phase] = {}


class PhaseStateMachine:
    """Conversation phase state machine for dynamic tool permissions."""

    def get_current_phase(self, thread_id: str | None = None) -> Phase:
        key = _thread_key(thread_id)
        if key:
            return _phase_by_thread.get(key, Phase.PLANNING)
        return _phase_var.get()

    def set_phase(self, phase: Phase, thread_id: str | None = None) -> None:
        key = _thread_key(thread_id)
        if key:
            _phase_by_thread[key] = phase
            return
        _phase_var.set(phase)

    def get_allowed_tools(self, thread_id: str | None = None) -> set[str]:
        """Return the tool names visible in the current phase."""
        return set(PHASE_TOOLS[self.get_current_phase(thread_id)])

    def is_tool_allowed(self, tool_name: str, thread_id: str | None = None) -> bool:
        """Check whether a tool is visible in the current phase."""
        return tool_name in self.get_allowed_tools(thread_id)

    def try_transition(self, signal: str, thread_id: str | None = None) -> bool:
        """Try a forward phase transition. Return True when transition succeeds."""
        current = self.get_current_phase(thread_id)
        next_phase = TRANSITION_CONDITIONS.get(current, {}).get(signal)
        if next_phase:
            self.set_phase(next_phase, thread_id)
            return True
        return False

    def reset(self, thread_id: str | None = None) -> None:
        """Reset the phase to PLANNING for a new session."""
        self.set_phase(Phase.PLANNING, thread_id)


phase_machine = PhaseStateMachine()


async def reset_phase_state(context: dict[str, Any]) -> dict[str, Any] | None:
    thread_id = _context_thread_id(context)
    phase_machine.reset(thread_id)
    return {"phase": Phase.PLANNING.value}


def _context_thread_id(context: dict[str, Any]) -> str | None:
    value = context.get("thread_id") or get_thread_id()
    return str(value) if value else None


def _thread_key(thread_id: str | None) -> str | None:
    value = thread_id or get_thread_id()
    return str(value) if value else None
