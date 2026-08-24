"""持久工作集：绑定宇宙是 pool，展示集是 display。K 是上限。"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .world import World
from .world_ops import infer_form

PRICE_SPAN_MIN = 400.0
_VARIANT_WORDS = frozenset(
    {
        "black", "white", "blue", "red", "green", "purple", "pink", "gray",
        "grey", "silver", "gold", "mauve", "cloud", "navy", "beige", "黑色",
        "白色", "蓝色", "红色", "绿色", "紫色", "粉色", "灰色", "银色", "金色",
    }
)


def entity_family_key(title: str) -> str:
    """Conservative product-family key: collapse color-only listing variants."""
    tokens = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", title.casefold())
    core = [token for token in tokens if token not in _VARIANT_WORDS]
    return " ".join(core) or title.casefold().strip()


@dataclass(frozen=True)
class DecisionQuality:
    n: int
    form_split: bool
    merchant_split: bool
    market_split: bool
    price_span: bool

    @property
    def axes(self) -> int:
        return sum((self.form_split, self.merchant_split, self.market_split, self.price_span))

    @property
    def discriminable(self) -> bool:
        return self.n >= 2 and self.axes >= 2


@dataclass(frozen=True)
class WorkingSet:
    pool: tuple[dict, ...] = ()
    display: tuple[dict, ...] = ()
    mentioned: tuple[dict, ...] = ()

    @classmethod
    def from_cache(
        cls,
        payload: dict | None,
        *,
        mentioned_ids: list[str] | None = None,
        comparison_ids: list[str] | None = None,
    ) -> WorkingSet:
        data = payload or {}
        display = tuple(item for item in list(data.get("ranked") or []) if isinstance(item, dict))
        raw_pool = list(data.get("pool") or [])
        pool = tuple(item for item in raw_pool if isinstance(item, dict)) or display
        by_id = {str(item.get("snapshot_id")): item for item in pool if item.get("snapshot_id")}
        for item in display:
            sid = item.get("snapshot_id")
            if sid and str(sid) not in by_id:
                by_id[str(sid)] = item
        wanted = [str(item) for item in list(mentioned_ids or []) + list(comparison_ids or []) if item]
        mentioned = tuple(by_id[sid] for sid in wanted if sid in by_id)
        return cls(pool=tuple(by_id.values()) if by_id else pool, display=display, mentioned=mentioned)

    @property
    def bind_records(self) -> list[dict]:
        seen: set[str] = set()
        out: list[dict] = []
        for item in (*self.pool, *self.mentioned, *self.display):
            sid = str(item.get("snapshot_id") or "")
            if sid and sid in seen:
                continue
            if sid:
                seen.add(sid)
            out.append(item)
        return out

    def world(self) -> World:
        return World.from_ranked(self.bind_records)

    @property
    def merchants(self) -> tuple[str, ...]:
        return self.world().merchants

    def quality(self, records: list[dict] | None = None) -> DecisionQuality:
        return decision_quality(records if records is not None else list(self.display or self.pool))


def decision_quality(records: list[dict]) -> DecisionQuality:
    forms: set[str] = set()
    merchants: set[str] = set()
    markets: set[str] = set()
    prices: list[float] = []
    for item in records:
        form = infer_form(str(item.get("title") or ""))
        if form:
            forms.add(form)
        merchant = str(item.get("merchant") or "").strip()
        if merchant:
            merchants.add(merchant.lower())
        market = str(item.get("market") or item.get("country_code") or "").strip()
        if market:
            markets.add(market.upper())
        amount = _cny(item)
        if amount is not None:
            prices.append(amount)
    span = bool(prices) and (max(prices) - min(prices)) >= PRICE_SPAN_MIN
    return DecisionQuality(
        n=len(records),
        form_split=len(forms) >= 2,
        merchant_split=len(merchants) >= 2,
        market_split=len(markets) >= 2,
        price_span=span,
    )


def select_decision_set(records: list[dict], *, limit: int) -> list[dict]:
    """覆盖不同形态/商户/市场，再按原序截断。不满 limit。"""
    if limit <= 0 or not records:
        return []
    picked: list[dict] = []
    seen: set[str] = set()
    covered_form: set[str] = set()
    covered_merchant: set[str] = set()
    covered_market: set[str] = set()
    covered_entity: set[str] = set()

    def take(item: dict, *, allow_cross_market_entity: bool = False) -> None:
        sid = str(item.get("snapshot_id") or id(item))
        entity = entity_family_key(str(item.get("title") or ""))
        if (
            sid in seen
            or (entity in covered_entity and not allow_cross_market_entity)
            or len(picked) >= limit
        ):
            return
        seen.add(sid)
        picked.append(item)
        covered_entity.add(entity)
        form = infer_form(str(item.get("title") or ""))
        if form:
            covered_form.add(form)
        merchant = str(item.get("merchant") or "").strip().lower()
        if merchant:
            covered_merchant.add(merchant)
        market = str(item.get("market") or item.get("country_code") or "").strip().upper()
        if market:
            covered_market.add(market)

    # Market coverage is a hard presentation invariant when the feasible pool
    # contains more than one requested market. Merchant diversity must not use
    # every slot before a later market is considered.
    for item in records:
        market = str(item.get("market") or item.get("country_code") or "").strip().upper()
        if market and market not in covered_market:
            take(item, allow_cross_market_entity=True)
    for item in records:
        form = infer_form(str(item.get("title") or ""))
        if form and form not in covered_form:
            take(item)
    for item in records:
        merchant = str(item.get("merchant") or "").strip().lower()
        if merchant and merchant not in covered_merchant:
            take(item)
    for item in records:
        take(item)
    return picked


def _cny(item: dict) -> float | None:
    estimated = item.get("estimated_cny")
    if isinstance(estimated, dict) and estimated.get("amount") is not None:
        return float(estimated["amount"])
    raw = item.get("estimated_cny")
    if raw is not None and not isinstance(raw, dict):
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None
    return None
