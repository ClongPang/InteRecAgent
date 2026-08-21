"""按角色投影任务记忆。权威状态仍是 Mission；模型只收视图，不 dump 全量 belief / 目录。"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from statistics import median

from ..dto.belief import PreferenceBelief, SpecGate
from ..dto.mission import ShoppingMission


def _cny_of(item: object) -> float | None:
    if hasattr(item, "rmb_price") and not getattr(item, "fx_failed", False):
        price = getattr(item, "rmb_price", None)
        return float(price) if price is not None else None
    if not isinstance(item, dict):
        return None
    estimated = item.get("estimated_cny")
    if isinstance(estimated, dict) and estimated.get("amount") is not None:
        return float(estimated["amount"])
    raw = item.get("rmb_price")
    return float(raw) if raw is not None else None


def _title_of(item: object) -> str:
    if hasattr(item, "title"):
        return str(getattr(item, "title") or "")
    if isinstance(item, dict):
        return str(item.get("title") or "")
    return ""


def _id_of(item: object) -> str | None:
    if hasattr(item, "id"):
        value = getattr(item, "id")
        return str(value) if value else None
    if isinstance(item, dict):
        value = item.get("snapshot_id") or item.get("id") or item.get("source_product_id")
        return str(value) if value else None
    return None


def _brief(item: object) -> dict:
    data = {
        "id": _id_of(item),
        "title": _title_of(item),
        "cny": _cny_of(item),
    }
    if isinstance(item, dict):
        data["snapshot_id"] = item.get("snapshot_id") or data["id"]
        data["merchant"] = item.get("merchant")
    else:
        data["merchant"] = getattr(item, "merchant", None)
    return {key: value for key, value in data.items() if value is not None}


@dataclass(frozen=True)
class TurnView:
    """分类器窗口：本轮邻接 + DST 摘要 + 工作集，不含 listing key / 全量 ranked。"""

    query: str | None
    budget_cny: float | None
    dst: dict
    excluded_terms: list[str]
    last_user: str | None
    last_agent: str | None
    last_act: str | None
    focus: dict | None
    comparison: list[dict] = field(default_factory=list)
    ranked_preview: list[dict] = field(default_factory=list)

    set_merchants: list[str] = field(default_factory=list)

    def as_classify_payload(self) -> dict:
        return {
            "query": self.query,
            "budget_cny": self.budget_cny,
            "dst": self.dst,
            "excluded_terms": self.excluded_terms,
            "last_user": self.last_user,
            "last_agent": self.last_agent,
            "last_act": self.last_act,
            "focus": self.focus,
            "comparison": self.comparison,
            "ranked": self.ranked_preview,
            "set_merchants": self.set_merchants,
            "recent_user_texts": [self.last_user] if self.last_user else [],
        }


@dataclass(frozen=True)
class CatalogStats:
    found: int
    kept: int
    price_min: float | None
    price_p50: float | None
    price_max: float | None
    gate_hits: dict[str, int]
    clusters: dict[str, int]
    sample: list[dict]

    def as_payload(self) -> dict:
        return {
            "found": self.found,
            "kept": self.kept,
            "price": {"min": self.price_min, "p50": self.price_p50, "max": self.price_max},
            "gate_hits": self.gate_hits,
            "clusters": self.clusters,
            "sample": self.sample,
        }


def turn_view(
    mission: ShoppingMission | None,
    cache_payload: dict | None,
    events: list[dict] | None = None,
) -> TurnView:
    constraints = getattr(mission, "constraints", None)
    belief: PreferenceBelief = getattr(mission, "belief", None) or PreferenceBelief()
    dialogue = getattr(mission, "dialogue", None)
    ranked = [item for item in list((cache_payload or {}).get("ranked") or []) if isinstance(item, dict)]
    pool = [item for item in list((cache_payload or {}).get("pool") or ranked) if isinstance(item, dict)]
    by_id = {str(item.get("snapshot_id")): item for item in ranked if item.get("snapshot_id")}
    compare_ids = list(getattr(mission, "comparison_snapshot_ids", None) or [])
    last_user, last_agent = _adjacent_pair(events)
    focus_id = getattr(dialogue, "focus_snapshot_id", None)
    return TurnView(
        query=getattr(constraints, "query", None),
        budget_cny=getattr(constraints, "budget_cny", None),
        dst=belief.dst_summary(),
        excluded_terms=list(getattr(constraints, "excluded_terms", None) or []),
        last_user=last_user,
        last_agent=last_agent,
        last_act=getattr(dialogue, "last_act", None),
        focus=_brief(by_id[focus_id]) if focus_id and focus_id in by_id else None,
        comparison=[_brief(by_id[sid]) for sid in compare_ids if sid in by_id],
        ranked_preview=[_brief(item) for item in ranked[:3]],
        set_merchants=list(
            dict.fromkeys(
                str(item.get("merchant")).strip()
                for item in pool
                if item.get("merchant")
            )
        ),
    )


def catalog_stats(
    products: list,
    *,
    gates: list[SpecGate] | None = None,
    found: int | None = None,
    sample_size: int = 3,
) -> CatalogStats:
    items = list(products or [])
    prices = [price for price in (_cny_of(item) for item in items) if price is not None]
    gates = list(gates or [])
    hits = {gate.attr: sum(1 for item in items if _title_hits(_title_of(item), gate.cues)) for gate in gates}
    clusters: dict[str, list] = defaultdict(list)
    for item in items:
        clusters[_cluster_label(_title_of(item), gates)].append(item)
    sample: list[dict] = []
    for bucket in clusters.values():
        if bucket and len(sample) < sample_size:
            sample.append(_brief(bucket[0]))
    if len(sample) < sample_size:
        for item in items:
            brief = _brief(item)
            if brief not in sample:
                sample.append(brief)
            if len(sample) >= sample_size:
                break
    return CatalogStats(
        found=found if found is not None else len(items),
        kept=len(items),
        price_min=min(prices) if prices else None,
        price_p50=float(median(prices)) if prices else None,
        price_max=max(prices) if prices else None,
        gate_hits=hits,
        clusters={key: len(value) for key, value in clusters.items()},
        sample=sample,
    )


def draft_candidates(
    ranked: list,
    *,
    compare_ids: list[str] | None = None,
    limit: int = 5,
) -> list:
    """起草只看主推、两件备选、当前比较集。"""
    picked: list = []
    seen: set[str] = set()

    def take(item: object) -> None:
        key = _id_of(item)
        if not key or key in seen or len(picked) >= limit:
            return
        seen.add(key)
        picked.append(item)

    for item in list(ranked[:1]) + list(ranked[1:3]):
        take(item)
    wanted = set(compare_ids or [])
    if wanted:
        for item in ranked:
            ident = _id_of(item)
            snap = item.get("snapshot_id") if isinstance(item, dict) else ident
            if ident in wanted or (snap and str(snap) in wanted):
                take(item)
    return picked


def _adjacent_pair(events: list[dict] | None) -> tuple[str | None, str | None]:
    last_user = None
    last_agent = None
    for event in events or []:
        kind = event.get("event_type") if isinstance(event, dict) else None
        payload = event.get("payload") if isinstance(event, dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        if kind == "message.received" and payload.get("text"):
            last_user = str(payload["text"])
        if kind == "agent.message" and payload.get("text"):
            last_agent = str(payload["text"])[:180]
        if kind == "clarification.required" and payload.get("question"):
            last_agent = str(payload["question"])[:180]
    return last_user, last_agent


def _title_hits(title: str, cues: list[str]) -> bool:
    blob = title.lower()
    return any(cue.lower() in blob for cue in cues if cue)


def _cluster_label(title: str, gates: list[SpecGate]) -> str:
    blob = title.lower()
    for gate in gates:
        if _title_hits(blob, gate.cues):
            return gate.attr
    if any(token in blob for token in ("monitor", "display", "显示器", "屏幕")):
        return "monitor"
    if any(token in blob for token in ("headphone", "earbuds", "耳机", "headset")):
        return "audio"
    if any(token in blob for token in ("shoe", "boot", "鞋")):
        return "footwear"
    return "other"
