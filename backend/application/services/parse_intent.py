"""确定性需求解析器。query 来自剥槽后的 leftover，不靠品类白名单。"""
from __future__ import annotations

import re

from ..dto import IntentPatch
from ..dto.belief import SpecGate

CLARIFYING_QUESTION = "您想买什么？请提供商品型号或品类，例如「降噪耳机」「27 寸 4K 显示器」「徒步鞋」。"

_MARKET_NAMES: dict[str, str] = {
    "US": r"美国|United States|America",
    "SG": r"新加坡|Singapore",
    "VN": r"越南|Vietnam",
    "TH": r"泰国|Thailand",
    "MY": r"马来西亚|Malaysia",
}

_SWITCH_QUERY = re.compile(r"改找|换成|换一类|改买|不要这个品类")
_RESIDUAL = re.compile(r"^(?:[嗯啊哦好的吧了呢哈]+|看看|找找|瞧瞧|看一下|先看看)$")
_USE_SUIT = re.compile(r"适合(?P<use>.+?)的")
_USE_GIFT = re.compile(r"送给(?P<who>[^的，,。\s]{1,8})的")

_SPEC_GATE_ALIASES = {
    "anc": "noise_cancelling",
    "active_noise_cancellation": "noise_cancelling",
    "noise_reduction_type": "noise_cancelling",
    "noise_cancellation": "noise_cancelling",
    "over_ear": "overear",
    "over-ear": "overear",
    "in_ear": "inear",
    "in-ear": "inear",
}
_SPEC_GATE_DEFAULT_CUES = {
    "noise_cancelling": [
        "noise cancelling",
        "noise canceling",
        "active noise cancellation",
        "anc",
        "降噪",
    ],
    "overear": ["头戴", "over-ear", "over ear", "headset"],
    "inear": ["入耳", "耳塞", "earbud", "earbuds", "in-ear"],
    "4k": ["4k", "2160", "uhd", "3840"],
}


def canonicalize_spec_gates(gates: list[SpecGate] | None) -> list[SpecGate]:
    """Collapse model synonyms onto stable, evidence-evaluable spec facets."""
    merged: dict[str, SpecGate] = {}
    for gate in gates or []:
        raw_attr = re.sub(r"\s+", "_", (gate.attr or "").strip().casefold())
        raw_cues = [str(item).strip() for item in gate.cues if str(item).strip()]
        cue_blob = " ".join(raw_cues).casefold()
        attr = _SPEC_GATE_ALIASES.get(raw_attr, raw_attr)
        if attr not in _SPEC_GATE_DEFAULT_CUES:
            if re.search(r"\banc\b|active noise|主动降噪", cue_blob, re.I):
                attr = "noise_cancelling"
            elif re.search(r"over[- ]?ear|头戴", cue_blob, re.I):
                attr = "overear"
            elif re.search(r"in[- ]?ear|earbuds?|入耳|耳塞", cue_blob, re.I):
                attr = "inear"
        cues = list(_SPEC_GATE_DEFAULT_CUES.get(attr) or raw_cues)
        if not attr or (gate.required and not cues):
            continue
        normalized = SpecGate(attr=attr, cues=cues, required=gate.required)
        existing = merged.get(attr)
        if existing is None or (normalized.required and not existing.required):
            merged[attr] = normalized
    return list(merged.values())


def parse_budget(text: str) -> float | None:
    """Parse an amount only when it has explicit budget or currency context.

    Product model names frequently contain three- or four-digit numbers (for
    example WH-1000XM5).  A bare number must therefore never become a hard
    budget constraint.
    """
    s = re.sub(r",", "", text)
    number = r"(\d{2,7}(?:\.\d+)?)"
    prefix = (
        r"(?:预算(?:\s*(?:改为|为|是))?|不超过|控制在|最高(?:预算)?|预算上限|"
        r"改为|budget(?:\s+(?:is|was))?|under|below|"
        r"maximum(?:\s+budget)?(?:\s+(?:is|was))?|up\s+to|around)"
    )
    currency = r"(?:CNY|RMB|CN¥|¥|￥)"
    suffix = r"(?:元|块|人民币|CNY|RMB|yuan)"
    patterns = (
        rf"{prefix}\s*{currency}?\s*{number}\s*{suffix}?",
        rf"{currency}\s*{number}",
        rf"{number}\s*{suffix}",
    )
    m = next((match for pattern in patterns if (match := re.search(pattern, s, re.I))), None)
    n = float(m.group(1)) if m else None
    return n if n is not None and n >= 100 else None


def parse_markets(text: str) -> list[str] | None:
    positive_text = re.sub(
        r"(?:not|except|excluding)\s+(?:the\s+)?(?:United States|America|Singapore|Vietnam|Thailand|Malaysia|US|SG|VN|TH|MY)\b",
        "",
        text,
        flags=re.I,
    )
    positive_text = re.sub(r"(?:不要|排除|不搜)\s*(?:美国|新加坡|越南|泰国|马来西亚)", "", positive_text)
    found: list[str] = []
    for code, pattern in _MARKET_NAMES.items():
        if re.search(pattern, positive_text, re.I) or re.search(
            rf"(?<![A-Z]){code}(?![A-Z])", positive_text
        ):
            found.append(code)
    return found or None


def sanitize_inferred_merchants(values: list[str] | None) -> list[str] | None:
    """Reject model-inferred merchant values that are only market qualifiers."""
    if values is None:
        return None
    kept: list[str] = []
    for value in values:
        text = str(value).strip()
        if not text:
            continue
        if parse_markets(text) and not extract_query(text):
            continue
        if text not in kept:
            kept.append(text)
    return kept


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
        r"\b(?:budget(?:\s+is)?|under|below|maximum(?:\s+budget)?(?:\s+is)?|"
        r"up\s+to|around)\s*(?:CNY|RMB)?\s*[\d,]+(?:\.\d+)?"
        r"\s*(?:CNY|RMB|yuan)?\b",
        "",
        text,
        flags=re.I,
    )
    s = re.sub(
        r"(?:budget(?:\s+is)?|under|below|maximum(?:\s+budget)?(?:\s+is)?|up\s+to|around)"
        r"\s*(?:CNY|RMB|CN¥|¥|￥)?\s*[\d,]+(?:\.\d+)?\s*(?:CNY|RMB|yuan)?",
        "",
        s,
        flags=re.I,
    )
    s = re.sub(
        r"(?:预算|不超过|到|改为)\s*[¥￥]?\s*[\d,]+(?:\.\d+)?\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?",
        "",
        s,
        flags=re.I,
    )
    s = re.sub(r"[¥￥]\s*[\d,]+(?:\.\d+)?\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?", "", s, flags=re.I)
    if parse_markets(text):
        english_market = (
            r"(?:United States|America|Singapore|Vietnam|Thailand|Malaysia|"
            r"US|SG|VN|TH|MY)"
        )
        s = re.sub(
            rf"(?:only\s+)?{english_market}"
            rf"(?:\s*(?:and|or|/|,)\s*{english_market})*(?:\s+only)?",
            "",
            s,
            flags=re.I,
        )
        s = re.sub(r"\b(?:only|markets?)\b", "", s, flags=re.I)
    market = r"(?:美国|新加坡|越南|泰国|马来西亚)"
    s = re.sub(
        rf"(?:只看|仅看)?\s*{market}(?:\s*(?:和|或|/|、)\s*{market})*",
        "",
        s,
    )
    s = re.sub(
        r"只看有货|仅看有货|优先\s*续航|优先\s*降噪|最低商品价|低价优先|价格优先",
        "",
        s,
    )
    # Constraint directives belong to Goal constraints, not the target phrase.
    # Keep the positive spec token (for example ANC) useful for retrieval, but
    # remove command wrappers and trailing negative clauses already represented
    # by exclusion operations.
    s = re.sub(r"(?:必须|务必|一定要|需要)\s*(?:支持|具备|带有|有)?\s*", "", s)
    s = re.sub(
        r"(?:不要|排除|不考虑|别要)\s*[^，,。；;]+(?=$|[，,。；;])",
        "",
        s,
    )
    s = re.sub(
        r"(?:在|从)?\s*(?:和|或|/|、)?\s*(?:这些)?市场(?:中|里)?\s*(?:进行)?\s*(?:比较|对比|比价|搜索|查找)?",
        "",
        s,
    )
    s = re.sub(r"^(?:帮我找|帮我买|帮我挑|帮我|我想买|我要买|我要找|我想|想买|请帮我|给我|要买|买|找)\s*", "", s)
    s = re.sub(r"^一[副个台件双只]\s*", "", s)
    s = re.sub(r"^适合.+?的\s*", "", s)
    s = re.sub(r"^送给[^的，,。\s]{1,8}的\s*", "", s)
    s = re.sub(r"\d{3,6}\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?", "", s, flags=re.I)
    s = re.sub(r"[，,。；;、]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


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
            SpecGate(attr="screen_size", cues=["27 inch", "27-inch", '27"'], required=True)
        )
    if re.search(r"头戴|over-?ear|headset", lowered, re.I) and not re.search(r"不要头戴", raw):
        gates.append(SpecGate(attr="overear", cues=["头戴", "over-ear", "over ear", "headset"], required=True))
    if re.search(r"入耳|耳塞|earbuds?|in-?ear", lowered, re.I) and not re.search(
        r"不要入耳|不要耳塞", raw
    ):
        gates.append(SpecGate(attr="inear", cues=["入耳", "耳塞", "earbud", "earbuds", "in-ear"], required=True))
    return canonicalize_spec_gates(gates)


def normalize_exclude_terms(terms: list[str] | None) -> list[str]:
    """Canonicalize negative requirements at every ingestion boundary.

    Model adapters may return both a compound phrase and its atomic members.
    The Goal ledger must store only atomic, case-insensitively unique terms so
    control and explicit-V2 execution paths cannot diverge.
    """
    normalized: list[str] = []
    seen: set[str] = set()
    ignored = {"这款", "这一款", "这个", "它", "this", "this one", "it"}
    for raw_term in terms or []:
        term = re.sub(r"[的了呢啊]+$", "", str(raw_term).strip(" .")).strip()
        for item in re.split(r"\s*(?:、|以及|或|和|/|\bor\b|\band\b)\s*", term, flags=re.I):
            item = item.strip()
            key = item.casefold()
            if item and key not in ignored and key not in seen:
                normalized.append(item)
                seen.add(key)
    return normalized


def extract_exclude_terms(text: str) -> list[str] | None:
    """Extract explicit negative requirements independently of act routing.

    A sentence may contain both a retrieval request and words such as ``比较``
    or ``不要``.  Those words can change the dialogue-act label, but must not
    make the negative requirement disappear from the constraint ledger.
    """
    raw = text or ""
    matches = [
        *re.finditer(r"(?:不要|排除|不考虑|别要)\s*([^，,。；;]+)", raw),
        *re.finditer(r"\b(?:not|exclude|excluding|without)\s+([^,.;]+)", raw, re.I),
    ]
    excluded: list[str] = []
    for match in sorted(matches, key=lambda item: item.start()):
        excluded.extend(normalize_exclude_terms([match.group(1)]))
    return normalize_exclude_terms(excluded) or None


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
    exclude_terms = extract_exclude_terms(text)
    use_case = extract_use_case(text)
    spec_gates = extract_spec_gates(text)

    if query is None and not current_query:
        return IntentPatch(
            budget_cny=budget,
            markets=markets,
            preference=preference,
            only_in_stock=only_in_stock,
            exclude_terms=exclude_terms,
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
        exclude_terms=exclude_terms,
        use_case=use_case,
        spec_gates=spec_gates or None,
        requires_clarification=False,
    )
