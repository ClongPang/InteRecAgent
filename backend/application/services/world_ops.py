"""对当前候选世界的运算：集合询问、对照维度、展示名。不是回复模板。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..dto.dialogue import NextMove, SetPredicate

_STOCK_ONLY = re.compile(r"只看有货|仅看有货")
_FORM_WANT = re.compile(r"(?:只要|只看|仅看).+(?:头戴|入耳|耳塞|开放)")
_ASK_SET = re.compile(
    r"有(?:没有)?\s*(?P<label>.+?)(?:平台|商户|店站)\s*的?\s*吗",
    re.I,
)
_ASK_SET_BARE = re.compile(
    r"有(?:没有)?\s*(?P<label>lazada|shopee|amazon|shopify|best\s*buy|qoo10|ezbuy)\s*的?\s*吗",
    re.I,
)
_WANT_MERCHANT = re.compile(
    r"(?:只要|只看|仅看)\s*(?P<label>.+?)(?:平台|商户|店)?$",
    re.I,
)
_RESERVED_FILTER = frozenset(
    {
        "有货",
        "库存",
        "现货",
        "头戴",
        "入耳",
        "耳塞",
        "开放",
        "开放式",
        "美国",
        "新加坡",
        "越南",
        "泰国",
        "马来",
        "马来西亚",
        "us",
        "sg",
        "vn",
        "th",
        "my",
    }
)
_FORM_CUES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("头戴", ("头戴", "over-ear", "over ear", "overear", "headset", "over ear")),
    ("入耳", ("入耳", "耳塞", "earbud", "earbuds", "in-ear", "inear", "earphone", "真無線", "真无线")),
    ("开放式", ("open-ear", "open ear", "开放式", "open headphone")),
)


@dataclass(frozen=True)
class SetHit:
    snapshot_id: str
    title: str
    merchant: str | None
    market: str | None
    display_name: str


@dataclass(frozen=True)
class SetQueryResult:
    predicate: SetPredicate
    hits: list[SetHit]
    scanned: int
    merchants_present: list[str]

    @property
    def matched(self) -> bool:
        return bool(self.hits)


@dataclass(frozen=True)
class CompareDimension:
    name: str
    values: list[str]

    @property
    def differs(self) -> bool:
        unique = {item for item in self.values if item}
        return len(unique) > 1


@dataclass(frozen=True)
class CompareResult:
    names: list[str]
    snapshot_ids: list[str]
    dimensions: list[CompareDimension] = field(default_factory=list)
    cheaper_index: int | None = None
    prices: list[str] = field(default_factory=list)

    @property
    def non_price_diffs(self) -> list[CompareDimension]:
        return [item for item in self.dimensions if item.name != "估算" and item.differs]

    @property
    def comparable(self) -> bool:
        return bool(self.non_price_diffs) or any(item.name == "估算" and item.differs for item in self.dimensions)


def parse_set_predicate(text: str) -> SetPredicate | None:
    raw = (text or "").strip()
    if not raw or _STOCK_ONLY.search(raw):
        return None
    match = _ASK_SET.search(raw) or _ASK_SET_BARE.search(raw)
    if not match:
        return None
    label = _clean_label(match.group("label"))
    if not label or label in _RESERVED_FILTER:
        return None
    return SetPredicate(attr="merchant", values=[label.lower()], label=label)


def parse_merchant_needles(text: str) -> list[str] | None:
    raw = (text or "").strip()
    if not raw or _STOCK_ONLY.search(raw) or _FORM_WANT.search(raw):
        return None
    match = _WANT_MERCHANT.search(raw)
    if not match:
        return None
    label = _clean_label(match.group("label"))
    if not label or label in _RESERVED_FILTER:
        return None
    return [label.lower()]


def evaluate_set_query(ranked: list[dict], predicate: SetPredicate) -> SetQueryResult:
    needles = [item.strip().lower() for item in predicate.values if item and item.strip()]
    hits: list[SetHit] = []
    seen_merchants: list[str] = []
    for record in ranked:
        merchant = _record_merchant(record)
        if merchant and merchant not in seen_merchants:
            seen_merchants.append(merchant)
        if needles and not _merchant_matches(record, needles):
            continue
        sid = record.get("snapshot_id")
        if not sid:
            continue
        title = str(record.get("title") or "当前候选")
        hits.append(
            SetHit(
                snapshot_id=str(sid),
                title=title,
                merchant=merchant,
                market=_record_market(record),
                display_name=display_name(title, record.get("brand")),
            )
        )
    return SetQueryResult(
        predicate=predicate,
        hits=hits,
        scanned=len(ranked),
        merchants_present=seen_merchants,
    )


def compare_candidates(records: list[dict]) -> CompareResult | None:
    if len(records) < 2:
        return None
    names: list[str] = []
    ids: list[str] = []
    forms: list[str] = []
    merchants: list[str] = []
    markets: list[str] = []
    prices: list[str] = []
    amounts: list[float | None] = []
    for record in records:
        title = str(record.get("title") or "当前候选")
        names.append(display_name(title, record.get("brand")))
        sid = record.get("snapshot_id")
        ids.append(str(sid) if sid else "")
        forms.append(infer_form(title) or "")
        merchants.append(_record_merchant(record) or "")
        markets.append(_record_market(record) or "")
        amount = _record_cny(record)
        amounts.append(amount)
        prices.append(f"{amount:.0f} 元" if amount is not None else "未换算")
    dimensions = [
        CompareDimension(name="形态", values=forms),
        CompareDimension(name="商户", values=merchants),
        CompareDimension(name="市场", values=markets),
        CompareDimension(name="估算", values=prices),
    ]
    priced = [(index, amount) for index, amount in enumerate(amounts) if amount is not None]
    cheaper = None
    if len(priced) >= 2:
        lowest = min(priced, key=lambda item: item[1] or 0)
        if sum(1 for item in priced if item[1] == lowest[1]) == 1:
            cheaper = lowest[0]
    return CompareResult(
        names=names,
        snapshot_ids=ids,
        dimensions=dimensions,
        cheaper_index=cheaper,
        prices=prices,
    )


def display_name(title: str | None, brand: str | None = None) -> str:
    text = (title or "").strip() or "当前候选"
    parts = [part.strip() for part in text.split(",") if part.strip()]
    if len(parts) >= 2 and len(parts[0]) <= 48:
        head = f"{parts[0]}, {parts[1]}"
        return head if len(head) <= 60 else parts[0]
    if brand and brand.lower() in text.lower() and len(text) > 48:
        return brand
    return text if len(text) <= 48 else text[:45] + "…"


def infer_form(title: str | None) -> str | None:
    blob = (title or "").lower()
    for label, cues in _FORM_CUES:
        if any(cue in blob for cue in cues):
            return label
    return None


def set_query_next_moves(
    result: SetQueryResult, *, query: str | None
) -> list[NextMove]:
    label = result.predicate.label or result.predicate.values[0] if result.predicate.values else "该平台"
    product = (query or "这类商品").strip()
    if result.matched:
        return [
            NextMove(label=f"只要{label}", text=f"只要{label}"),
            NextMove(label="对比前两件", text="帮我比前两个"),
        ]
    return [
        NextMove(label=f"再搜{label}", text=f"帮我找{label}上的{product}"),
        NextMove(label="维持当前列表", text="先看现在这几款"),
    ]


def _clean_label(raw: str) -> str:
    return re.sub(r"^(?:的|了)+|(?:的|了)+$", "", (raw or "").strip(" 的了呢啊吗？?"))


def _record_merchant(record: dict) -> str | None:
    value = record.get("merchant")
    return str(value).strip() or None if value else None


def _record_market(record: dict) -> str | None:
    value = record.get("market") or record.get("country_code")
    return str(value).strip() or None if value else None


def _merchant_matches(record: dict, needles: list[str]) -> bool:
    blob = f"{record.get('merchant') or ''} {record.get('title') or ''}".lower()
    return any(needle in blob for needle in needles)


def _record_cny(record: dict) -> float | None:
    estimated = record.get("estimated_cny")
    if isinstance(estimated, dict) and estimated.get("amount") is not None:
        return float(estimated["amount"])
    raw = record.get("estimated_cny")
    if raw is not None and not isinstance(raw, dict):
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None
    return None
