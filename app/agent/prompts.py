# app/agent/prompts.py
from collections.abc import Mapping, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml


@lru_cache(maxsize=1)
def _load_prompts() -> dict:
    cfg_path = Path(__file__).parent.parent / "prompt" / "prompts.yml"
    with cfg_path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def get_system_prompt(long_term_preferences: str = "") -> str:
    """主 / 子 AgentLoop 共用的 system prompt (带长期偏好注入位)。"""
    template = _load_prompts()["system_prompt"]
    preferences = long_term_preferences or "(暂无沉淀偏好)"
    return template.format(long_term_preferences=preferences)


def get_planner_prompt() -> str:
    return _load_prompts()["planner_prompt"]


def get_shopping_summary_prompt() -> str:
    return _load_prompts()["shopping_summary_prompt"]


def get_dispatch_demands_template() -> str:
    return _load_prompts()["dispatch_demands_template"]


def format_dispatch_demands(
    platform: str,
    category: str,
    hard_constraints: Sequence[Any] | None = None,
    soft_preferences: Sequence[Any] | None = None,
    sort_by: str = "综合匹配度",
    top_n: int = 5,
    fields: Sequence[Any] | None = None,
) -> str:
    """Render a self-contained dispatch_tool demands prompt."""
    hard = _join_prompt_values(hard_constraints, fallback="无额外硬约束")
    soft = _join_prompt_values(soft_preferences, fallback="无额外软偏好")
    field_text = _join_prompt_values(
        fields or ["价格", "评分", "是否可直邮"],
        fallback="价格 / 评分 / 是否可直邮",
    )
    return "\n".join([
        f"在 {platform} 平台检索 {category}，满足以下约束：",
        f"  - 硬约束：{hard}",
        f"  - 软偏好：{soft}",
        f"检索后按 {sort_by} 取 Top {top_n}，为每件补齐 {field_text}。",
        "返回：一个不超过 "
        f"{top_n} 条的候选列表摘要，每条含 名称/价格/平台/关键卖点，",
        "     不要返回原始 API 全量响应（大内容留在子 loop 内）。",
    ])


def get_tool_result_compression_decision_prompt() -> str:
    return get_tool_result_compress_prompt()


def get_tool_result_compress_prompt() -> str:
    return _load_prompts()["tool_result_compress_prompt"]


def get_conversation_summary_prompt() -> str:
    return get_session_summary_prompt()


def get_session_summary_prompt() -> str:
    return _load_prompts()["session_summary_prompt"]


def get_rubric_judge_prompt() -> str:
    return _load_prompts()["rubric_judge_prompt"]


def format_rubric_judge_prompt(
    p0_items: str | Sequence[Any],
    p1_items: str | Sequence[Any],
    p2_items: str | Sequence[Any],
) -> str:
    """Render the model-based Rubric judge prompt without touching YAML braces."""
    template = get_rubric_judge_prompt()
    return (
        template
        .replace("{p0_items}", _format_prompt_items(p0_items))
        .replace("{p1_items}", _format_prompt_items(p1_items))
        .replace("{p2_items}", _format_prompt_items(p2_items))
    )


def build_system_reminder(
    reminders: str | Mapping[str, Any] | Sequence[Any] | None,
) -> str:
    """Render dynamic constraints as a late message-flow reminder."""
    content = _format_reminders(reminders)
    if not content:
        return ""
    return _load_prompts()["system_reminder_template"].replace("{reminders}", content)


def _format_prompt_items(items: str | Sequence[Any]) -> str:
    if isinstance(items, str):
        return items.strip() or "（无）"

    lines: list[str] = []
    for item in items:
        if isinstance(item, Mapping):
            dimension = item.get("dimension")
            description = item.get("description") or item.get("text") or item
            line = f"{dimension}: {description}" if dimension else str(description)
        else:
            dimension = getattr(item, "dimension", None)
            description = getattr(item, "description", None)
            line = f"{dimension}: {description}" if dimension and description else str(item)
        lines.append(f"- {line}")

    return "\n".join(lines) or "（无）"


def _join_prompt_values(items: Sequence[Any] | None, fallback: str) -> str:
    if not items:
        return fallback
    rendered = [str(item).strip() for item in items if str(item).strip()]
    return " / ".join(rendered) if rendered else fallback


def _format_reminders(
    reminders: str | Mapping[str, Any] | Sequence[Any] | None,
) -> str:
    if reminders is None:
        return ""
    if isinstance(reminders, str):
        return reminders.strip()
    if isinstance(reminders, Mapping):
        lines = []
        for key, value in reminders.items():
            rendered = value if isinstance(value, str) else repr(value)
            lines.append(f"{key}: {rendered}")
        return "\n".join(lines)
    return "\n".join(str(item).strip() for item in reminders if str(item).strip())
