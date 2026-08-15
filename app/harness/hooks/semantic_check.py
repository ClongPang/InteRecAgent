from __future__ import annotations

from typing import Any

from app.agent.llm import get_lite_llm


SEMANTIC_CHECK_TOOLS = {"item_search", "category_insight"}

SEMANTIC_CHECK_PROMPT = """判断以下工具返回是否和用户需求相关。
用户需求：{query}
工具返回摘要（前 200 字）：{result_preview}

只回答"相关"或"不相关"，不要解释。"""


async def check_semantic_alignment(context: dict[str, Any]) -> dict[str, Any] | None:
    """Run a lightweight semantic alignment check for high-value tools."""
    tool_name = str(context.get("tool_name") or "")
    if tool_name not in SEMANTIC_CHECK_TOOLS:
        return None

    query = str(context.get("original_query") or context.get("query") or "")
    result = context.get("tool_result")
    if not query or result is None:
        return None

    result_preview = str(result)[:200]
    try:
        response = await get_lite_llm().ainvoke([
            ("user", SEMANTIC_CHECK_PROMPT.format(
                query=query,
                result_preview=result_preview,
            )),
        ])
    except Exception as exc:
        return {"semantic_check_skipped": str(exc)}

    judgment = str(getattr(response, "content", response))
    if "不相关" not in judgment:
        return None

    failures = list(context.get("assertions_failed") or [])
    failures.append({
        "type": "semantic",
        "tool": tool_name,
        "reason": "tool result is not aligned with the original query",
    })
    return {"assertions_failed": failures}
