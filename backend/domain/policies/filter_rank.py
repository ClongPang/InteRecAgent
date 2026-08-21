from __future__ import annotations

import re
from collections.abc import Iterable

from ..models import FxSnapshot, NormalizedProduct


def convert_products(
    products: Iterable[NormalizedProduct], rates: dict[str, FxSnapshot]
) -> list[NormalizedProduct]:
    """按 rates[currency] 换算人民币价。缺少某币种汇率时该商品 fx_failed=True（保留原币）。"""
    out: list[NormalizedProduct] = []
    for p in products:
        snap = rates.get(p.native_currency)
        if snap is not None:
            out.append(
                p.model_copy(
                    update={
                        "rmb_price": round(p.native_price_amount * snap.rate, 2),
                        "fx_as_of": snap.date,
                    }
                )
            )
        else:
            out.append(p.model_copy(update={"fx_failed": True}))
    return out


def apply_stock_filter(
    products: Iterable[NormalizedProduct],
) -> tuple[list[NormalizedProduct], list[NormalizedProduct], list[NormalizedProduct]]:
    """只丢掉已确认无货。未知留下。全未知则不算一次过滤。"""
    items = list(products)
    if not any(p.in_stock is not None for p in items):
        return items, [], []
    kept = [p for p in items if p.in_stock is not False]
    out = [p for p in items if p.in_stock is False]
    unknown = [p for p in items if p.in_stock is None]
    return kept, out, unknown


# (query hints, any-of category cues, optional any-of form cues that must also hit)
_CATEGORY_CUES: tuple[tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]], ...] = (
    (("显示器", "屏幕", "monitor", "display"), ("monitor", "display", "显示器", "屏幕"), ()),
    (
        ("耳机", "headphone", "earbuds", "earbud", "降噪"),
        ("headphone", "headset", "earbuds", "earbud", "earphones", "耳机", "anc", "降噪"),
        (),
    ),
    (
        ("徒步鞋", "登山鞋"),
        ("hiking", "trek", "徒步", "trail"),
        ("shoe", "boot", "sneaker", "trainer", "鞋", "靴"),
    ),
    (("运动鞋", "跑鞋"), ("running", "athletic", "sneaker", "跑鞋", "运动鞋"), ("shoe", "sneaker", "trainer", "鞋")),
    (("鞋", "shoe"), ("shoe", "boot", "sneaker", "trainer", "sandal", "hiking", "鞋"), ()),
)


_QUERY_STOP = frozenset(
    {
        "寸",
        "元",
        "块",
        "以内",
        "之内",
        "适合",
        "的",
        "帮我",
        "我想",
        "买",
        "找",
        "挑",
        "and",
        "for",
        "the",
        "with",
        "inch",
    }
)
_ACCESSORY_PHRASES = ("log book", "mouse pad", "hdmi cable", "display cable")
_ACCESSORY_WORDS = (
    "cable",
    "cables",
    "hdmi",
    "adapter",
    "charger",
    "dongle",
    "bracket",
    "case",
    "cases",
    "cover",
    "cushion",
    "replacement",
    "book",
    "journal",
    "notebook",
    "sock",
    "socks",
    "insole",
    "laces",
)
_ACCESSORY_CJK = ("线材", "转接头", "充电器", "保护套", "日记本", "手册")


def relevance_cues(query: str | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
    text = (query or "").lower()
    if not text:
        return (), ()
    for hints, cues, forms in _CATEGORY_CUES:
        if any(hint in text for hint in hints):
            return cues, forms
    return (), ()


def query_tokens(query: str | None) -> list[str]:
    """从检索词抽出可对照标题的片段。停用词和单字不进入。"""
    text = (query or "").lower()
    if not text:
        return []
    tokens: list[str] = []
    for match in re.finditer(r"4k|8k|uhd|fhd|[a-z][a-z0-9\-]{2,}|\d{2,}", text):
        token = match.group(0)
        if token not in _QUERY_STOP:
            tokens.append(token)
    for match in re.finditer(r"[\u4e00-\u9fff]{2,}", text):
        token = match.group(0)
        if token not in _QUERY_STOP:
            tokens.append(token)
    return tokens


def title_is_accessory(title: str | None) -> bool:
    """线材、套子、日记本等附属品。英文按词边界，避免 mountain / standard 误杀。"""
    blob = (title or "").lower()
    if any(phrase in blob for phrase in _ACCESSORY_PHRASES):
        return True
    if any(cue in blob for cue in _ACCESSORY_CJK):
        return True
    return any(re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", blob) for word in _ACCESSORY_WORDS)


def _category_hit(title: str, cues: tuple[str, ...], forms: tuple[str, ...]) -> bool:
    hit = any(cue in title for cue in cues)
    if hit and forms:
        hit = any(form in title for form in forms)
    return hit


def _token_hit(title: str, tokens: list[str]) -> bool:
    return bool(tokens) and any(token in title for token in tokens)


def apply_relevance_filter(
    products: Iterable[NormalizedProduct], query: str | None
) -> tuple[list[NormalizedProduct], list[NormalizedProduct]]:
    """丢掉品类对不上或明显是配件的召回。

    先走品类线索（配件即使带 Monitor 也丢）。没有品类词时用检索词片段（27 / 4K）
    弱匹配。耳机/显示器这类无形态约束的品类，再回退到「非配件」以免 COWIN E7
    这种纯型号名被误杀。徒步鞋有形态约束，回退会把音箱灌回来，故宁可空集。
    """
    items = list(products)
    cues, forms = relevance_cues(query)
    tokens = query_tokens(query)
    if not cues and not tokens:
        return items, []

    def rest(kept_items: list[NormalizedProduct]) -> list[NormalizedProduct]:
        kept_ids = {item.id for item in kept_items}
        return [item for item in items if item.id not in kept_ids]

    category_kept: list[NormalizedProduct] = []
    if cues:
        for product in items:
            title = (product.title or "").lower()
            if _category_hit(title, cues, forms) and not title_is_accessory(title):
                category_kept.append(product)
        if category_kept:
            return category_kept, rest(category_kept)

    token_kept = [
        product
        for product in items
        if not title_is_accessory(product.title) and _token_hit((product.title or "").lower(), tokens)
    ]
    if token_kept:
        return token_kept, rest(token_kept)

    if cues and not forms:
        fallback = [product for product in items if not title_is_accessory(product.title)]
        if fallback:
            return fallback, rest(fallback)
        return [], items
    if cues:
        return [], items
    return items, []


def apply_spec_gates(
    products: Iterable[NormalizedProduct], gates: Iterable[object]
) -> tuple[list[NormalizedProduct], list[NormalizedProduct]]:
    """required 门闩：标题须命中 cues。会清空则原样返回。"""
    items = list(products)
    required = [
        gate
        for gate in gates
        if getattr(gate, "required", False) and getattr(gate, "cues", None)
    ]
    if not required:
        return items, []
    kept: list[NormalizedProduct] = []
    dropped: list[NormalizedProduct] = []
    for product in items:
        title = (product.title or "").lower()
        if all(any(str(cue).lower() in title for cue in gate.cues if cue) for gate in required):
            kept.append(product)
        else:
            dropped.append(product)
    if not kept:
        return items, []
    return kept, dropped


def apply_merchant_filter(
    products: Iterable[NormalizedProduct], needles: Iterable[str]
) -> tuple[list[NormalizedProduct], list[NormalizedProduct]]:
    """商户/平台是过滤键：标题或 merchant 字段含子串即留。"""
    keys = [item.strip().lower() for item in needles if item and item.strip()]
    if not keys:
        return list(products), []
    kept: list[NormalizedProduct] = []
    dropped: list[NormalizedProduct] = []
    for product in products:
        blob = f"{product.merchant or ''} {product.title or ''}".lower()
        if any(key in blob for key in keys):
            kept.append(product)
        else:
            dropped.append(product)
    return kept, dropped


def apply_exclusion_filter(
    products: Iterable[NormalizedProduct], terms: list[str]
) -> tuple[list[NormalizedProduct], list[NormalizedProduct]]:
    """标题包含排除词则去掉。无品牌字段时只能用标题子串，不得编造品牌。"""
    needles = [t.lower() for t in terms if t and t.strip()]
    if not needles:
        return list(products), []
    kept: list[NormalizedProduct] = []
    dropped: list[NormalizedProduct] = []
    for p in products:
        title = p.title.lower()
        if any(term in title for term in needles):
            dropped.append(p)
        else:
            kept.append(p)
    return kept, dropped


def apply_budget_filter(
    products: Iterable[NormalizedProduct], budget_cny: float
) -> tuple[list[NormalizedProduct], list[NormalizedProduct], list[NormalizedProduct]]:
    """预算硬过滤。返回 (保留, 超预算排除, 换算失败保留)。换算失败的商品不因预算排除，
    遵循"部分成功是正常结果"原则——但排序时置于最后。"""
    kept: list[NormalizedProduct] = []
    over: list[NormalizedProduct] = []
    fx_failed: list[NormalizedProduct] = []
    for p in products:
        if p.fx_failed:
            fx_failed.append(p)
        elif p.rmb_price is not None and p.rmb_price <= budget_cny:
            kept.append(p)
        else:
            over.append(p)
    return kept, over, fx_failed


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "", title.lower())


def dedupe_products(products: Iterable[NormalizedProduct]) -> list[NormalizedProduct]:
    """同 merchant + 归一化 title 去重，保留第一次出现。"""
    seen: set[tuple[str | None, str]] = set()
    out: list[NormalizedProduct] = []
    for p in products:
        key = (p.merchant, _title_key(p.title))
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def rank_products(products: Iterable[NormalizedProduct]) -> list[NormalizedProduct]:
    """默认人民币价升序；换算失败排最后。以 updated_at 新→旧、id 保证同价下确定性。"""
    return sorted(
        products,
        key=lambda p: (
            p.fx_failed,
            p.rmb_price if p.rmb_price is not None else float("inf"),
            -(p.updated_at.timestamp() if p.updated_at else 0.0),
            p.id,
        ),
    )
