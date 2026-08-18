"""确定性需求解析器（AGT-006）。无 LLM Key 时支撑基础验收场景。

query 只在高置信品类/显式换品类时写入，残句不得覆盖检索词。
"""
from __future__ import annotations

import re

from ..dto import IntentPatch

CLARIFYING_QUESTION = "您想买什么？请提供商品型号或品类，例如「降噪耳机」「27 寸 4K 显示器」「徒步鞋」。"

_MARKET_WORDS: dict[str, str] = {
    "US": r"美国|\bus\b",
    "SG": r"新加坡|\bsg\b",
    "VN": r"越南|\bvn\b",
    "TH": r"泰国|\bth\b",
    "MY": r"马来|\bmy\b",
}

_PRODUCT_HINT = re.compile(
    r"耳机|降噪|头戴|入耳|显示器|屏幕|4k|徒步鞋|运动鞋|跑鞋|登山鞋|鞋|"
    r"headphone|earbuds|monitor",
    re.I,
)
_SWITCH_QUERY = re.compile(r"改找|换成|换一类|改买|不要这个品类")


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


def _strip_known_slots(text: str) -> str:
    s = re.sub(
        r"(?:预算|不超过|到|改为)\s*[¥￥]?\s*[\d,]+(?:\.\d+)?\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?",
        "",
        text,
        flags=re.I,
    )
    s = re.sub(r"[¥￥]\s*[\d,]+(?:\.\d+)?\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?", "", s, flags=re.I)
    s = re.sub(
        r"只看有货|仅看有货|优先\s*续航|优先\s*降噪|最低商品价|低价优先|价格优先|美国|新加坡|越南|泰国|马来西亚",
        "",
        s,
    )
    s = re.sub(r"^(?:帮我找|帮我买|帮我挑|帮我|我想买|我要买|我要找|我想|想买|请帮我|给我|要买|买|找)\s*", "", s)
    s = re.sub(r"^一[副个台件双只]\s*", "", s)
    s = re.sub(r"[，,。；;、]+", " ", s)
    return s.strip()


def extract_query(text: str, *, current_query: str | None = None) -> str | None:
    """只接受品类线索或显式换品类。『太贵了』等残句不得变成新 query。"""
    leftover = _strip_known_slots(text)
    if not leftover:
        return None
    if _SWITCH_QUERY.search(text):
        return leftover
    if _PRODUCT_HINT.search(leftover):
        return leftover
    if current_query:
        return None
    return leftover if _PRODUCT_HINT.search(text) else None


def parse_intent(text: str, *, current_query: str | None = None) -> IntentPatch:
    """将用户输入解析为结构化条件增量。无法识别商品查询且任务尚无 query 时追问。"""
    query = extract_query(text, current_query=current_query)
    budget = parse_budget(text)
    markets = parse_markets(text)
    preference = parse_preference(text)
    only_in_stock = True if re.search(r"只看有货|仅看有货", text) else None

    if query is None and not current_query:
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
