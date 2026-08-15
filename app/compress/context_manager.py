from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from app.agent.prompts import build_system_reminder
from app.agent.system_prompt import build_system_prompt
from app.compress.breakpoint import Message, compute_breakpoint
from app.compress.compressor import compress_after_breakpoint
from app.utils.path_utils import ensure_session_dir


HOT_CONTEXT_FILE = "hot_context.json"
TASK_STATE_FILE = "task_state.json"
WORKING_MEMORY_FILE = "working_memory.json"
MESSAGES_FILE = "messages.json"


def build_context(
    thread_id: str,
    session_dir: Path | str | None,
    current_request: str,
    *,
    long_term_preferences: str = "",
    system_reminders: str | Mapping[str, Any] | Sequence[Any] | None = None,
    keep_recent_tools: int = 3,
    max_tool_result_chars: int = 2000,
) -> list[Message]:
    """Build the minimal prompt context for one model request.

    This is the code version of the document's Context Manager flow:
    structured task state and working memory are rendered explicitly, the stable
    message prefix remains unchanged, and only the suffix after the Cache
    Breakpoint is eligible for lightweight compression.
    """
    session_path = _resolve_session_dir(thread_id, session_dir)

    hot_context = load_hot_context(thread_id, session_path)
    hot_context["current_request"] = current_request

    task_state = load_task_state(thread_id, session_path)
    working_memory = retrieve_working_memory(thread_id, current_request, session_path)
    raw_messages = load_recent_messages(thread_id, session_path)

    breakpoint_idx = compute_breakpoint(raw_messages, keep_recent=keep_recent_tools)
    messages = compress_after_breakpoint(
        raw_messages,
        breakpoint_idx,
        max_tool_result_chars=max_tool_result_chars,
    )

    context: list[Message] = [
        {"role": "system", "content": build_system_prompt(long_term_preferences)},
        {"role": "system", "content": render_hot_context(hot_context)},
        {"role": "system", "content": render_task_state(task_state)},
        {"role": "system", "content": render_working_memory(working_memory)},
        *messages,
    ]

    reminder = build_system_reminder(system_reminders)
    if reminder:
        context.append({"role": "system", "content": reminder})

    context.append({"role": "user", "content": current_request})
    return context


def load_hot_context(
    thread_id: str,
    session_dir: Path | str | None = None,
) -> dict[str, Any]:
    data = _read_json(_resolve_session_dir(thread_id, session_dir) / HOT_CONTEXT_FILE, {})
    return data if isinstance(data, dict) else {}


def load_task_state(
    thread_id: str,
    session_dir: Path | str | None = None,
) -> dict[str, Any]:
    data = _read_json(_resolve_session_dir(thread_id, session_dir) / TASK_STATE_FILE, {})
    return data if isinstance(data, dict) else {}


def retrieve_working_memory(
    thread_id: str,
    current_request: str,
    session_dir: Path | str | None = None,
) -> dict[str, Any]:
    data = _read_json(_resolve_session_dir(thread_id, session_dir) / WORKING_MEMORY_FILE, {})
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        return {"items": data}
    return {}


def load_recent_messages(
    thread_id: str,
    session_dir: Path | str | None = None,
) -> list[Message]:
    data = _read_json(_resolve_session_dir(thread_id, session_dir) / MESSAGES_FILE, [])
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def render_hot_context(hot_context: dict[str, Any]) -> str:
    return _render_structured_block("hot_context", hot_context)


def render_task_state(task_state: dict[str, Any]) -> str:
    return _render_structured_block("task_state", task_state)


def render_working_memory(working_memory: dict[str, Any]) -> str:
    return _render_structured_block("working_memory", working_memory)


def _render_structured_block(name: str, value: dict[str, Any]) -> str:
    if not value:
        return f"{name}: {{}}"
    return f"{name}:\n{json.dumps(value, ensure_ascii=False, indent=2)}"


def _resolve_session_dir(thread_id: str, session_dir: Path | str | None) -> Path:
    if session_dir is None:
        return ensure_session_dir(thread_id)
    return Path(session_dir)


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)
