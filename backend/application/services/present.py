"""把内部快照/候选记录投影为对外 ViewModel（规格 §6.3 / §6.5）。"""
from __future__ import annotations

from datetime import datetime

from ...domain.models import FxSnapshot, NormalizedProduct
from ..dto.public import EstimatedCny, NativePrice, ProductCandidate
from ..dto.runner import RecommendationDraft


def https_url(url: str | None) -> str | None:
    if url and url.startswith("https://"):
        return url
    return None


def candidate_record(
    product: NormalizedProduct,
    *,
    snapshot_id: str,
    fx: FxSnapshot | None,
    rank: int,
    budget_cny: float | None,
) -> dict:
    """写入 candidate_sets 的稳定记录。比较/推荐只引用 snapshot_id。"""
    estimated = None
    if not product.fx_failed and product.rmb_price is not None and fx is not None:
        estimated = {
            "amount": product.rmb_price,
            "rate": fx.rate,
            "source": fx.source,
            "rate_date": fx.date,
            "fetched_at": fx.fetched_at.isoformat() if fx.fetched_at else None,
        }
    reasons: list[str] = []
    if budget_cny is not None and product.rmb_price is not None and product.rmb_price <= budget_cny:
        reasons.append("within_budget")
    if rank == 1 and not product.fx_failed:
        reasons.append("lowest_estimated_cny")
    return {
        "snapshot_id": snapshot_id,
        "source": "buywhere",
        "source_product_id": product.id,
        "title": product.title,
        "merchant": product.merchant,
        "market": product.country_code,
        "native_price": {
            "amount": product.native_price_amount,
            "currency": product.native_currency,
        },
        "estimated_cny": estimated,
        "fx_failed": product.fx_failed,
        "unavailable_fields": list(product.unavailable),
        "merchant_url": https_url(product.click_url) or https_url(product.url),
        "source_updated_at": product.updated_at.isoformat() if product.updated_at else None,
        "rank": rank,
        "decision_reasons": reasons,
    }


def remap_draft(draft: RecommendationDraft, snapshot_map: dict[str, str]) -> RecommendationDraft:
    def _sid(source_id: str | None) -> str | None:
        if not source_id:
            return None
        return snapshot_map.get(source_id, source_id)

    primary = _sid(draft.primary_snapshot_id)
    alts = [sid for sid in (_sid(i) for i in draft.alternative_snapshot_ids) if sid]
    cited = [sid for sid in (_sid(i) for i in draft.cited_evidence_ids) if sid]
    return RecommendationDraft(
        primary_snapshot_id=primary or "",
        alternative_snapshot_ids=alts,
        rationale=draft.rationale,
        tradeoffs=draft.tradeoffs,
        cited_evidence_ids=cited,
    )


def product_candidate_from_record(item: dict, *, rank: int | None = None) -> ProductCandidate | None:
    snapshot_id = item.get("snapshot_id")
    source_product_id = item.get("source_product_id") or item.get("id")
    if not snapshot_id or not source_product_id:
        return None
    native = item.get("native_price")
    if isinstance(native, dict) and native.get("amount") is not None:
        native_price = NativePrice(amount=float(native["amount"]), currency=str(native.get("currency") or ""))
    elif item.get("native_price_amount") is not None:
        native_price = NativePrice(
            amount=float(item["native_price_amount"]),
            currency=str(item.get("native_currency") or ""),
        )
    else:
        return None
    estimated = _estimated_cny(item)
    updated = _parse_dt(item.get("source_updated_at") or item.get("updated_at"))
    return ProductCandidate(
        snapshot_id=str(snapshot_id),
        source=str(item.get("source") or "buywhere"),
        source_product_id=str(source_product_id),
        title=str(item.get("title") or ""),
        merchant=item.get("merchant"),
        market=item.get("market") or item.get("country_code"),
        native_price=native_price,
        estimated_cny=estimated,
        fx_failed=bool(item.get("fx_failed")),
        unavailable_fields=list(item.get("unavailable_fields") or item.get("unavailable") or []),
        merchant_url=https_url(item.get("merchant_url"))
        or https_url(item.get("click_url"))
        or https_url(item.get("url")),
        source_updated_at=updated,
        rank=item.get("rank") if item.get("rank") is not None else rank,
        decision_reasons=list(item.get("decision_reasons") or []),
    )


def product_candidate_from_snapshot(snapshot: dict, *, rank: int | None = None) -> ProductCandidate | None:
    normalized = snapshot.get("normalized") or snapshot
    record = {
        "snapshot_id": snapshot.get("id") or normalized.get("snapshot_id"),
        "source": snapshot.get("source") or "buywhere",
        "source_product_id": snapshot.get("source_product_id") or normalized.get("id"),
        **normalized,
        "market": normalized.get("country_code"),
        "merchant_url": normalized.get("click_url") or normalized.get("url"),
        "source_updated_at": normalized.get("updated_at"),
        "unavailable_fields": normalized.get("unavailable") or [],
    }
    return product_candidate_from_record(record, rank=rank)


def _estimated_cny(item: dict) -> EstimatedCny | None:
    raw = item.get("estimated_cny")
    if isinstance(raw, dict) and raw.get("amount") is not None and raw.get("rate") is not None:
        return EstimatedCny(
            amount=float(raw["amount"]),
            rate=float(raw["rate"]),
            source=str(raw.get("source") or ""),
            rate_date=str(raw.get("rate_date") or ""),
            fetched_at=_parse_dt(raw.get("fetched_at")),
        )
    if item.get("fx_failed") or item.get("rmb_price") is None:
        return None
    amount = float(item["rmb_price"])
    native = item.get("native_price_amount")
    rate = amount / float(native) if native else None
    if rate is None:
        return None
    return EstimatedCny(
        amount=amount,
        rate=rate,
        source="",
        rate_date=str(item.get("fx_as_of") or ""),
    )


def _parse_dt(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
