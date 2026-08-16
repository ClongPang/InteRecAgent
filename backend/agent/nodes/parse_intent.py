"""确定性需求解析器（AGT-006）。无 LLM Key 时支撑基础验收场景。

覆盖：预算、市场、耳机/显示器/徒步鞋查询、价格优先、续航优先、降噪优先、仅看有货。
无法可靠识别商品查询时必须返回 requires_clarification（BUS-002）。
"""
from __future__ import annotations

import re

from ...application.dto import IntentPatch

CLARIFYING_QUESTION = "您想买什么？请提供商品型号或品类，例如「降噪耳机」「27 寸 4K 显示器」「徒步鞋」。"

_MARKET_WORDS: dict[str, str] = {
    "US": r"美国|\bus\b",
    "SG": r"新加坡|\bsg\b",
    "VN": r"越南|\bvn\b",
    "TH": r"泰国|\bth\b",
    "MY": r"马来|\bmy\b",
}


def parse_budget(text: str) -> float | None:
    s = re.sub(r",", "", text)
    m = re.search(r"(?:预算|不超过|到|改为)?\s*[¥￥]?\s*(\d{3,6})\s*(?:元|块|人民币|rmb)", s, re.I)
    if not m:
        m = re.search(r"[¥￥]\s*(\d{3,6})", s)
    if not m:
        m = re.search(r"(?:预算|不超过|到|改为)\s*(\d{3,6})", s)
    n = float(m.group(1)) if m else None
    return n if n is not None and n >= 100 else None


def parse_markets(text: str) -> list[str] | None:
    found = [code for code, pat in _MARKET_WORDS.items() if re.search(pat, text, re.I)]
    return found or None


def parse_preference(text: str) -> str | None:
    if re.search(r"优先\s*续航", text):
        return "battery"
    if re.search(r"优先\s*降噪", text):
        return "noise"
    if re.search(r"最低商品价|低价优先|价格优先", text):
        return "lowest"
    return None


def extract_query(text: str) -> str | None:
    s = re.sub(
        r"(?:预算|不超过|到|改为)\s*[¥￥]?\s*[\d,]+(?:\.\d+)?\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?",
        "",
        text,
        flags=re.I,
    )
    s = re.sub(r"[¥￥]\s*[\d,]+(?:\.\d+)?\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?", "", s, flags=re.I)
    s = re.sub(r"只看有货|仅看有货|优先\s*续航|优先\s*降噪|最低商品价|低价优先|价格优先|美国|新加坡|越南|泰国|马来西亚", "", s)
    s = re.sub(r"^(?:帮我找|帮我买|帮我挑|帮我|我想买|我要买|我要找|我想|想买|请帮我|给我|要买|买|找)\s*", "", s)
    s = re.sub(r"^一[副个台件双只]\s*", "", s)
    s = re.sub(r"[，,。；;、]+", " ", s)
    return s.strip() or None


def parse_intent(text: str) -> IntentPatch:
    """将用户输入解析为结构化条件增量。无法识别商品查询时要求追问一个问题。"""
    query = extract_query(text)
    budget = parse_budget(text)
    markets = parse_markets(text)
    preference = parse_preference(text)
    only_in_stock = bool(re.search(r"只看有货|仅看有货", text))

    if query is None:
        return IntentPatch(
            budget_cny=budget,
            markets=markets,
            preference=preference,
            only_in_stock=only_in_stock,
            requires_clarification=True,
            clarification_question=CLARIFYING_QUESTION,
        )
    return IntentPatch(
        query=query,
        budget_cny=budget,
        markets=markets,
        preference=preference,
        only_in_stock=only_in_stock,
        requires_clarification=False,
    )
