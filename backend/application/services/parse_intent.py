"""确定性需求解析器。query 来自剥槽后的 leftover，不靠品类白名单。"""
from __future__ import annotations

import re

from ..dto import IntentPatch
from ..dto.belief import SpecGate

CLARIFYING_QUESTION = "您想买什么？请提供商品型号或品类，例如「降噪耳机」「27 寸 4K 显示器」「徒步鞋」。"

_MARKET_WORDS: dict[str, str] = {
    "US": r"美国|\bus\b",
    "SG": r"新加坡|\bsg\b",
    "VN": r"越南|\bvn\b",
    "TH": r"泰国|\bth\b",
    "MY": r"马来|\bmy\b",
}

_SWITCH_QUERY = re.compile(r"改找|换成|换一类|改买|不要这个品类")
_RESIDUAL = re.compile(r"^(?:[嗯啊哦好的吧了呢哈]+|看看|找找|瞧瞧|看一下|先看看)$")
_USE_SUIT = re.compile(r"适合(?P<use>.+?)的")
_USE_GIFT = re.compile(r"送给(?P<who>[^的，,。\s]{1,8})的")


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
    s = re.sub(r"^适合.+?的\s*", "", s)
    s = re.sub(r"^送给[^的，,。\s]{1,8}的\s*", "", s)
    s = re.sub(r"\d{3,6}\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?", "", s, flags=re.I)
    s = re.sub(r"[，,。；;、]+", " ", s)
    return s.strip()


def extract_use_case(text: str) -> str | None:
    gift = _USE_GIFT.search(text or "")
    if gift:
        return f"送给{gift.group('who')}"
    suit = _USE_SUIT.search(text or "")
    if suit:
        use = suit.group("use").strip("的了呢啊 ")
        return use or None
    return None


def extract_spec_gates(text: str) -> list[SpecGate]:
    raw = text or ""
    lowered = raw.lower()
    gates: list[SpecGate] = []
    if re.search(r"4k|2160|\buhd\b", lowered, re.I):
        gates.append(SpecGate(attr="4k", cues=["4k", "2160", "uhd", "3840"], required=True))
    if re.search(r"27\s*寸|27\s*[- ]?inch|27\"", lowered, re.I):
        gates.append(
            SpecGate(attr="27inch", cues=["27 inch", "27-inch", "27寸", '27"', "27 inch"], required=False)
        )
    if re.search(r"头戴|over-?ear|headset", lowered, re.I) and not re.search(r"不要头戴", raw):
        gates.append(SpecGate(attr="overear", cues=["头戴", "over-ear", "over ear", "headset"], required=True))
    if re.search(r"入耳|耳塞|earbuds?|in-?ear", lowered, re.I) and not re.search(
        r"不要入耳|不要耳塞", raw
    ):
        gates.append(SpecGate(attr="inear", cues=["入耳", "耳塞", "earbud", "earbuds", "in-ear"], required=True))
    return gates


def extract_query(text: str, *, current_query: str | None = None) -> str | None:
    """有当前 query 时只有显式换品类才覆盖；首句 leftover 即 query，不查品类表。"""
    leftover = _strip_known_slots(text)
    if not leftover or _RESIDUAL.match(leftover):
        return None
    if _SWITCH_QUERY.search(text):
        return leftover
    if current_query:
        return None
    return leftover


def parse_intent(text: str, *, current_query: str | None = None) -> IntentPatch:
    """将用户输入解析为结构化条件增量。无法识别商品查询且任务尚无 query 时追问。"""
    query = extract_query(text, current_query=current_query)
    budget = parse_budget(text)
    markets = parse_markets(text)
    preference = parse_preference(text)
    only_in_stock = True if re.search(r"只看有货|仅看有货", text) else None
    use_case = extract_use_case(text)
    spec_gates = extract_spec_gates(text)

    if query is None and not current_query:
        return IntentPatch(
            budget_cny=budget,
            markets=markets,
            preference=preference,
            only_in_stock=only_in_stock,
            use_case=use_case,
            spec_gates=spec_gates or None,
            requires_clarification=True,
            clarification_question=CLARIFYING_QUESTION,
        )
    return IntentPatch(
        query=query,
        budget_cny=budget,
        markets=markets,
        preference=preference,
        only_in_stock=only_in_stock,
        use_case=use_case,
        spec_gates=spec_gates or None,
        requires_clarification=False,
    )
