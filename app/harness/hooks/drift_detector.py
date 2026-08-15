from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from app.agent.llm import get_lite_llm
from app.api.context import get_thread_id


CHECK_INTERVAL = 3

DRIFT_CHECK_PROMPT = """你是一个购物 Agent 的漂移检测器。
用户的原始购物需求是：{original_query}
Agent 最近 3 轮的行为摘要：{recent_actions}

请判断 Agent 是否仍在朝着用户需求的方向前进。
只回答以下之一：
- "正常"：Agent 的行为合理地服务于用户需求
- "轻微偏离"：有偏离迹象但还可以纠正
- "严重偏离"：Agent 已经明显偏离用户需求

只回答判断结果，不要解释。"""

_round_counter_by_thread: dict[str, int] = defaultdict(int)
_severe_drift_by_thread: dict[str, int] = defaultdict(int)


async def reset_drift_state(context: dict[str, Any]) -> dict[str, Any] | None:
    thread_id = _thread_id(context)
    _round_counter_by_thread[thread_id] = 0
    _severe_drift_by_thread[thread_id] = 0
    return None


async def detect_drift(context: dict[str, Any]) -> dict[str, Any] | None:
    """Every CHECK_INTERVAL rounds, detect whether Agent behavior drifted."""
    thread_id = _thread_id(context)
    _round_counter_by_thread[thread_id] += 1
    if _round_counter_by_thread[thread_id] % CHECK_INTERVAL != 0:
        return None

    original_query = str(context.get("original_query") or context.get("query") or "")
    recent_actions = str(
        context.get("recent_actions_summary")
        or _summarize_recent_actions(context)
    )
    if not original_query or not recent_actions:
        return None

    precheck = _computational_drift_check(original_query, recent_actions, context)
    if precheck == "normal":
        _severe_drift_by_thread[thread_id] = 0
        return None

    judgment = await _judge_drift(original_query, recent_actions)
    return _apply_drift_judgment(context, judgment, original_query, thread_id)


def _computational_drift_check(
    query: str,
    recent_actions: str,
    context: dict[str, Any],
) -> str:
    keywords = set(re.findall(r"[\u4e00-\u9fff]+", query))
    if keywords:
        hits = sum(1 for keyword in keywords if keyword in recent_actions)
        if hits / len(keywords) < 0.2:
            return "suspicious"

    if int(context.get("consecutive_empty_results") or 0) >= 3:
        return "suspicious"

    if context.get("preference_violation_detected"):
        return "suspicious"

    recent_tokens = context.get("recent_round_tokens") or []
    historical_avg = context.get("historical_avg_tokens")
    if len(recent_tokens) >= 3 and historical_avg:
        recent_avg = sum(int(item) for item in recent_tokens[-3:]) / 3
        if recent_avg > float(historical_avg) * 2:
            return "suspicious"

    return "normal"


async def _judge_drift(original_query: str, recent_actions: str) -> str:
    try:
        response = await get_lite_llm().ainvoke([
            ("user", DRIFT_CHECK_PROMPT.format(
                original_query=original_query,
                recent_actions=recent_actions,
            )),
        ])
        return str(getattr(response, "content", response))
    except Exception:
        return "轻微偏离"


def _apply_drift_judgment(
    context: dict[str, Any],
    judgment: str,
    original_query: str,
    thread_id: str,
) -> dict[str, Any] | None:
    messages = list(context.get("inject_messages") or [])

    if "严重偏离" in judgment:
        _severe_drift_by_thread[thread_id] += 1
        messages.append({
            "role": "system",
            "content": (
                f"[漂移纠正] 检测到你的行为已偏离用户原始需求「{original_query[:50]}」。"
                "请重新聚焦到用户需求上，基于已有结果直接推进到比价或精挑环节。"
            ),
        })
        if _severe_drift_by_thread[thread_id] >= 2:
            messages.append({
                "role": "system",
                "content": (
                    "[强制收尾] 连续检测到严重漂移。"
                    "请立即基于已有结果调用 ShoppingSummary 给出回答，不要再发起新的检索。"
                ),
            })
            return {
                "inject_messages": messages,
                "drift_detected": "severe",
                "consecutive_severe_drift": _severe_drift_by_thread[thread_id],
                "force_finish": True,
            }
        return {
            "inject_messages": messages,
            "drift_detected": "severe",
            "consecutive_severe_drift": _severe_drift_by_thread[thread_id],
        }

    _severe_drift_by_thread[thread_id] = 0
    if "轻微偏离" in judgment:
        messages.append({
            "role": "system",
            "content": (
                "[漂移提醒] 你的行为有轻微偏离用户需求的倾向。"
                "请确保下一步行动和用户原始 query 直接相关。"
            ),
        })
        return {"inject_messages": messages, "drift_detected": "mild"}

    return None


def _summarize_recent_actions(context: dict[str, Any]) -> str:
    actions = context.get("recent_actions") or context.get("trajectory") or []
    return "\n".join(str(action) for action in actions[-3:])


def _thread_id(context: dict[str, Any]) -> str:
    return str(context.get("thread_id") or get_thread_id() or "default")
