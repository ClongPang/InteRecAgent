from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Literal

from app.observability.langfuse_client import score_trace


RubricTier = Literal["P0", "P1", "P2"]


@dataclass(frozen=True)
class RubricItem:
    tier: RubricTier
    dimension: str
    description: str
    weight: float = 1.0


@dataclass(frozen=True)
class DynamicRubric:
    """Query-specific Rubrics as Rewards scoring spec."""

    query: str
    p0: tuple[RubricItem, ...]
    p1: tuple[RubricItem, ...]
    p2: tuple[RubricItem, ...]

    def model_dump(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "p0": [asdict(item) for item in self.p0],
            "p1": [asdict(item) for item in self.p1],
            "p2": [asdict(item) for item in self.p2],
        }


def build_dynamic_rubric(query: str) -> DynamicRubric:
    """Build a deterministic fallback rubric for one shopping query.

    Production can replace this with a stronger judge model. Keeping the shape
    deterministic gives tests, offline eval, and bootstrap mode a real reward
    signal before model-based Rubric generation is configured.
    """
    p0 = [
        RubricItem("P0", "负向约束与人群匹配", "违反用户明确排除项或人群场景直接 fail"),
        RubricItem("P0", "价格与业务逻辑", "主体商品价格超过预算 1.5 倍直接 fail"),
        RubricItem("P0", "格式与安全", "泄露内部 ID、工具名或违禁内容直接 fail"),
    ]
    p1 = [
        RubricItem("P1", "Summary 模块完整性", "最终回答必须像购物摘要，包含商品、价格和推荐理由"),
        RubricItem("P1", "工具调用顺序", "检索、比较、精挑、总结的过程顺序应合理"),
        RubricItem("P1", "效率约束", "同一工具不应重复调用超过 5 次"),
    ]
    p2 = [
        RubricItem("P2", "需求覆盖度", "覆盖用户显式约束与隐式需求"),
        RubricItem("P2", "场景洞察力", "体现礼物、出差、B2B 等具体场景视角"),
        RubricItem("P2", "决策建议价值", "提供组合策略、对比分析、材质或预算建议"),
    ]
    return DynamicRubric(query=query, p0=tuple(p0), p1=tuple(p1), p2=tuple(p2))


async def evaluate_trajectory(trajectory: dict[str, Any]) -> dict[str, Any]:
    query = str(trajectory.get("query") or trajectory.get("user_query") or "")
    final_answer = _extract_final_answer(trajectory)
    tool_calls = _extract_tool_calls(trajectory)
    picks = _extract_picks(trajectory)
    rubric = build_dynamic_rubric(query)

    p0_failures = _evaluate_p0(query, final_answer, picks)
    p1_failures = _evaluate_p1(final_answer, tool_calls)
    p2_scores = _evaluate_p2(query, final_answer, picks)
    p2_average = sum(p2_scores.values()) / len(p2_scores)

    if p0_failures:
        total = 0
        passed = False
    else:
        process_score = max(0.0, 50.0 - 10.0 * len(p1_failures))
        quality_score = (p2_average / 5.0) * 50.0
        total = round(min(100.0, process_score + quality_score), 2)
        passed = total >= 70

    score = {
        "total": total,
        "passed": passed,
        "p0": "fail" if p0_failures else "pass",
        "p0_failures": p0_failures,
        "p1": {
            "failed": p1_failures,
            "penalty": 10 * len(p1_failures),
        },
        "p2": {
            "scores": p2_scores,
            "average": round(p2_average, 2),
        },
        "reward": _reward_dimensions(p0_failures, p1_failures, p2_scores),
        "sft_candidate": is_sft_candidate({"total": total, "passed": passed}),
        "rubric": rubric.model_dump(),
    }
    return score


async def evaluate_and_score(
    trajectory: dict[str, Any],
    trace_id: str,
) -> dict[str, Any]:
    score = await evaluate_trajectory(trajectory)

    score_trace(
        trace_id=trace_id,
        name="rubric_total",
        value=float(score["total"]) / 100.0,
        comment=f"P0={score['p0']} P1={score['p1']} P2={score['p2']}",
    )
    return score


def is_sft_candidate(score: dict[str, Any], threshold: float = 70.0) -> bool:
    return bool(score.get("passed")) and float(score.get("total", 0)) >= threshold


def _extract_final_answer(trajectory: dict[str, Any]) -> str:
    for key in ("final", "final_text", "answer", "output"):
        value = trajectory.get(key)
        if isinstance(value, str):
            return value
    result = trajectory.get("result")
    if isinstance(result, dict):
        return _extract_final_answer(result)
    return ""


def _extract_tool_calls(trajectory: dict[str, Any]) -> list[str]:
    explicit = trajectory.get("tool_calls") or trajectory.get("tools")
    if isinstance(explicit, list):
        return [_tool_name(item) for item in explicit if _tool_name(item)]

    names: list[str] = []
    for message in trajectory.get("messages", []):
        if not isinstance(message, dict):
            continue
        name = message.get("name") or message.get("tool_name")
        if name:
            names.append(str(name))
    return names


def _tool_name(item: Any) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return str(item.get("name") or item.get("tool_name") or "")
    return ""


def _extract_picks(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    picks = trajectory.get("picks")
    if picks is None and isinstance(trajectory.get("result"), dict):
        picks = trajectory["result"].get("picks")
    if not isinstance(picks, list):
        return []
    return [item for item in picks if isinstance(item, dict)]


def _evaluate_p0(
    query: str,
    final_answer: str,
    picks: list[dict[str, Any]],
) -> list[str]:
    text = f"{query}\n{final_answer}\n{picks}".lower()
    failures: list[str] = []

    if any(term in text for term in ("违禁品", "毒品", "枪支", "管制刀具")):
        failures.append("命中违禁内容")

    internal_pattern = re.compile(
        r"\b(item_id|tool_name|dispatch_tool|active_tasks|session_dir)\b",
        re.I,
    )
    if internal_pattern.search(final_answer):
        failures.append("泄露内部 ID 或工具名")

    budget = _extract_budget(query)
    prices = _extract_prices(final_answer, picks)
    if budget is not None and any(price > budget * 1.5 for price in prices):
        failures.append("主体商品价格超过预算 1.5 倍")

    if _violates_negative_constraint(
        query,
        final_answer,
        ("不要玩具", "别推玩具", "不接受玩具"),
        "玩具",
    ):
        failures.append("违反不要玩具的负向约束")
    if _violates_negative_constraint(
        query,
        final_answer,
        ("不要塑料", "非塑料", "不接受塑料"),
        "塑料",
    ):
        failures.append("违反不要塑料的负向约束")
    if _mentions_any(query, ("给男生", "男性", "男士")) and _mentions_any(
        final_answer,
        ("女士", "女款", "女生用品"),
    ):
        failures.append("人群性别场景冲突")

    return failures


def _evaluate_p1(final_answer: str, tool_calls: list[str]) -> list[str]:
    failures: list[str] = []
    if not _has_summary_shape(final_answer):
        failures.append("最终摘要缺少商品、价格或推荐理由")

    if tool_calls:
        if _first_index(tool_calls, "shopping_summary") < _first_index(tool_calls, "item_search"):
            failures.append("终结总结早于检索工具")
        if _first_index(tool_calls, "item_picker") < _first_index(tool_calls, "item_search"):
            failures.append("精挑工具早于检索工具")

        repeats = {name: tool_calls.count(name) for name in set(tool_calls)}
        if any(count > 5 for count in repeats.values()):
            failures.append("同一工具重复调用超过 5 次")

    return failures


def _evaluate_p2(
    query: str,
    final_answer: str,
    picks: list[dict[str, Any]],
) -> dict[str, int]:
    return {
        "需求覆盖度": _score_coverage(query, final_answer, picks),
        "场景洞察力": _score_scenario_insight(query, final_answer),
        "决策建议价值": _score_decision_value(final_answer),
    }


def _reward_dimensions(
    p0_failures: list[str],
    p1_failures: list[str],
    p2_scores: dict[str, int],
) -> dict[str, float]:
    p0_ok = 0.0 if p0_failures else 1.0
    p1_ok = max(0.0, 1.0 - len(p1_failures) / 3.0)
    return {
        "response_quality": round(sum(p2_scores.values()) / (5 * len(p2_scores)), 3),
        "process_compliance": round(p1_ok, 3),
        "query_decomposition": round(p2_scores["需求覆盖度"] / 5.0, 3),
        "item_relevance": p0_ok,
        "format_safety": p0_ok,
    }


def _has_summary_shape(final_answer: str) -> bool:
    has_price = bool(re.search(r"(¥|￥|\$|\bCNY\b|\bRMB\b|\d+\s*元)", final_answer, re.I))
    has_reason = _mentions_any(final_answer, ("理由", "推荐", "适合", "因为", "建议"))
    has_item = len(final_answer.strip()) >= 20
    return has_price and has_reason and has_item


def _score_coverage(query: str, final_answer: str, picks: list[dict[str, Any]]) -> int:
    signals = _query_signals(query)
    if not signals:
        return 3
    haystack = f"{final_answer}\n{picks}"
    hits = sum(1 for signal in signals if signal in haystack)
    ratio = hits / len(signals)
    if ratio >= 0.8:
        return 5
    if ratio >= 0.5:
        return 4
    if ratio > 0:
        return 3
    return 1


def _score_scenario_insight(query: str, final_answer: str) -> int:
    scenario_terms = {
        "礼物": ("礼物", "送", "收礼", "场景"),
        "粉丝": ("粉丝", "互动", "应援"),
        "出差": ("出差", "便携", "差旅"),
        "旅行": ("旅行", "便携", "收纳"),
        "批量": ("批量", "采购", "B2B"),
    }
    required = [terms for key, terms in scenario_terms.items() if key in query]
    if not required:
        return 3
    hits = sum(1 for terms in required if _mentions_any(final_answer, terms))
    if hits == len(required):
        return 5
    if hits:
        return 3
    return 1


def _score_decision_value(final_answer: str) -> int:
    markers = ("对比", "建议", "组合", "优先", "材质", "预算", "取舍", "备选")
    hits = sum(1 for marker in markers if marker in final_answer)
    if hits >= 3:
        return 5
    if hits >= 2:
        return 4
    if hits == 1:
        return 3
    return 1


def _query_signals(query: str) -> list[str]:
    signals: list[str] = []
    for marker in (
        "不要塑料",
        "不要玩具",
        "男生",
        "喝酒",
        "礼物",
        "粉丝",
        "旅行",
        "出差",
        "小众",
        "耐用",
        "可爱",
        "帅气",
        "有趣",
    ):
        if marker in query:
            signals.append(marker.replace("不要", ""))
    budget = _extract_budget(query)
    if budget is not None:
        signals.append(str(int(budget)) if budget.is_integer() else str(budget))
    return signals


def _extract_budget(query: str) -> float | None:
    match = re.search(
        r"(?:预算|以内|不超过|低于)?\s*(\d+(?:\.\d+)?)\s*(?:元|块|rmb|cny)",
        query,
        re.I,
    )
    if match:
        return float(match.group(1))
    return None


def _extract_prices(final_answer: str, picks: list[dict[str, Any]]) -> list[float]:
    prices: list[float] = []
    for pick in picks:
        value = pick.get("price") or pick.get("price_cny") or pick.get("final_price")
        price = _coerce_price(value)
        if price is not None:
            prices.append(price)

    for match in re.finditer(
        r"(?:¥|￥)?\s*(\d+(?:\.\d+)?)\s*(?:元|块|rmb|cny)?",
        final_answer,
        re.I,
    ):
        value = float(match.group(1))
        if value > 0:
            prices.append(value)
    return prices


def _coerce_price(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        match = re.search(r"(\d+(?:\.\d+)?)", value)
        if match:
            return float(match.group(1))
    return None


def _first_index(items: list[str], name: str) -> int:
    try:
        return items.index(name)
    except ValueError:
        return 10_000


def _mentions_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def _violates_negative_constraint(
    query: str,
    final_answer: str,
    query_markers: tuple[str, ...],
    banned_term: str,
) -> bool:
    if not _mentions_any(query, query_markers) or banned_term not in final_answer:
        return False
    safe_phrases = (
        f"不是{banned_term}",
        f"非{banned_term}",
        f"不含{banned_term}",
        f"没有{banned_term}",
        f"避免{banned_term}",
        f"已过滤{banned_term}",
        f"排除{banned_term}",
    )
    return not _mentions_any(final_answer, safe_phrases)
