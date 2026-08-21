"""当前候选世界，以及把开放针绑定到世界上。

封闭契约：五个市场及其别名、六种指示色。
开放名词（平台、品牌、品类）不进表；对着 ranked 的 merchant/title/brand 求值。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from ...domain.models import VALID_MARKETS

MARKET_ALIASES: dict[str, str] = {
    "美国": "US",
    "us": "US",
    "新加坡": "SG",
    "sg": "SG",
    "越南": "VN",
    "vn": "VN",
    "泰国": "TH",
    "th": "TH",
    "马来": "MY",
    "马来西亚": "MY",
    "my": "MY",
}

# 指示代词用的基本色，和 VALID_MARKETS 同类：封闭 schema，不是商品名词表。
_COLOR_EN: dict[str, str] = {
    "白": "white",
    "黑": "black",
    "蓝": "blue",
    "银": "silver",
    "红": "red",
    "粉": "pink",
}


class BindKind(StrEnum):
    MARKET = "market"
    MERCHANT = "merchant"
    TOKEN = "token"
    UNBOUND = "unbound"


@dataclass(frozen=True)
class Binding:
    kind: BindKind
    needle: str
    markets: tuple[str, ...] = ()
    snapshot_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class World:
    ranked: tuple[dict, ...] = ()

    @classmethod
    def from_ranked(cls, ranked: list[dict] | None) -> World:
        return cls(ranked=tuple(item for item in (ranked or []) if isinstance(item, dict)))

    @property
    def merchants(self) -> tuple[str, ...]:
        seen: list[str] = []
        for item in self.ranked:
            merchant = str(item.get("merchant") or "").strip()
            if merchant and merchant not in seen:
                seen.append(merchant)
        return tuple(seen)

    def bind_needle(self, needle: str) -> Binding:
        token = (needle or "").strip()
        if not token:
            return Binding(BindKind.UNBOUND, "")
        market = bind_market(token)
        if market:
            return Binding(BindKind.MARKET, token, markets=(market,))
        hits = self.lookup(token)
        if hits:
            return Binding(BindKind.TOKEN, token, snapshot_ids=hits)
        return Binding(BindKind.UNBOUND, token)

    def lookup(self, needle: str) -> tuple[str, ...]:
        variants = token_variants(needle)
        if not variants:
            return ()
        found: list[str] = []
        for item in self.ranked:
            blob = _record_blob(item)
            if any(variant in blob for variant in variants):
                sid = item.get("snapshot_id")
                if sid and str(sid) not in found:
                    found.append(str(sid))
        return tuple(found)


def bind_market(needle: str) -> str | None:
    raw = (needle or "").strip()
    if not raw:
        return None
    if raw.upper() in VALID_MARKETS:
        return raw.upper()
    return MARKET_ALIASES.get(raw.lower()) or MARKET_ALIASES.get(raw)


def token_variants(needle: str) -> tuple[str, ...]:
    raw = (needle or "").strip()
    if not raw:
        return ()
    out: list[str] = [raw.lower()]
    if raw.endswith("色") and len(raw) >= 2:
        out.append(raw[0].lower())
    for key, english in _COLOR_EN.items():
        if raw.startswith(key) or raw == key:
            out.append(english)
    # 去重且保序
    seen: list[str] = []
    for item in out:
        if item and item not in seen:
            seen.append(item)
    return tuple(seen)


def _record_blob(item: dict) -> str:
    attrs = item.get("attrs") if isinstance(item.get("attrs"), dict) else {}
    return " ".join(
        str(part)
        for part in (
            item.get("title"),
            item.get("brand"),
            item.get("merchant"),
            attrs.get("color"),
            attrs.get("brand"),
        )
        if part
    ).lower()
