"""把内部快照/候选记录投影为对外 ViewModel（规格 §6.3 / §6.5）。"""
from __future__ import annotations

from datetime import datetime

from ...domain.models import FxSnapshot, NormalizedProduct
from ...domain.policies.score import title_matches_preference
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
    preference: str = "balanced",
    price_sensitive: bool = False,
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
    if product.in_stock is True:
        reasons.append("in_stock")
    if preference in {"battery", "noise"} and title_matches_preference(product, preference):
        reasons.append(f"matches_{preference}_cue")
    if price_sensitive:
        reasons.append("price_sensitive")
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
        "brand": (product.attrs or {}).get("brand"),
        "availability": availability_label(product),
        "in_stock": product.in_stock,
        "availability_status": product.availability_status,
        "attrs": dict(product.attrs or {}),
        "derived_fields": list(product.derived_fields),
        "unavailable_fields": list(product.unavailable),
        "merchant_url": https_url(product.click_url) or https_url(product.url),
        "source_updated_at": product.updated_at.isoformat() if product.updated_at else None,
        "rank": rank,
        "decision_reasons": reasons,
    }


def availability_label(product: NormalizedProduct) -> str:
    status = product.availability_status
    if status in {"in_stock", "limited", "out_of_stock"}:
        return status
    if product.in_stock is True:
        return "in_stock"
    if product.in_stock is False:
        return "out_of_stock"
    return "unknown"


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
    attrs = item.get("attrs") if isinstance(item.get("attrs"), dict) else {}
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
        brand=item.get("brand") or attrs.get("brand"),
        availability=_availability_from_record(item),
        derived_fields=list(item.get("derived_fields") or []),
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


def hydrate_candidate_payload(payload: dict | None) -> tuple[list[NormalizedProduct], dict[str, str], dict[str, FxSnapshot], list[str]]:
    """从已持久化候选集重建过滤/排序输入，避免预算变化时重复抓取。"""
    if not payload:
        return [], {}, {}, []
    snapshot_map = {str(k): str(v) for k, v in (payload.get("snapshot_map") or {}).items()}
    rates: dict[str, FxSnapshot] = {}
    products: list[NormalizedProduct] = []
    for item in payload.get("ranked") or []:
        native = item.get("native_price") if isinstance(item.get("native_price"), dict) else {}
        amount = native.get("amount", item.get("native_price_amount"))
        currency = str(native.get("currency") or item.get("native_currency") or "")
        source_id = str(item.get("source_product_id") or item.get("id") or "")
        snapshot_id = item.get("snapshot_id")
        if amount is None or not source_id:
            continue
        if snapshot_id:
            snapshot_map.setdefault(source_id, str(snapshot_id))
        estimated = item.get("estimated_cny") if isinstance(item.get("estimated_cny"), dict) else {}
        rmb = estimated.get("amount", item.get("rmb_price"))
        fx_failed = bool(item.get("fx_failed"))
        if currency and estimated.get("rate") is not None:
            rates[currency] = FxSnapshot(
                base=currency,
                quote="CNY",
                rate=float(estimated["rate"]),
                date=str(estimated.get("rate_date") or item.get("fx_as_of") or ""),
                source=str(estimated.get("source") or "cached"),
            )
        in_stock, status = _hydrate_stock(item)
        attrs = item.get("attrs") if isinstance(item.get("attrs"), dict) else {}
        if item.get("brand") and "brand" not in attrs:
            attrs = {**attrs, "brand": str(item["brand"])}
        products.append(
            NormalizedProduct(
                id=source_id,
                title=str(item.get("title") or ""),
                merchant=item.get("merchant"),
                country_code=item.get("market") or item.get("country_code"),
                url=item.get("merchant_url") or item.get("url"),
                click_url=item.get("merchant_url") or item.get("click_url"),
                native_price_amount=float(amount),
                native_currency=currency,
                rmb_price=float(rmb) if rmb is not None else None,
                fx_as_of=str(estimated.get("rate_date") or item.get("fx_as_of") or "") or None,
                fx_failed=fx_failed,
                in_stock=in_stock,
                availability_status=status,
                attrs=attrs,
                derived_fields=list(item.get("derived_fields") or []),
                unavailable=list(item.get("unavailable_fields") or item.get("unavailable") or []),
                updated_at=_parse_dt(item.get("source_updated_at") or item.get("updated_at")),
            )
        )
    fx_ids = [str(i) for i in (payload.get("fx_snapshot_ids") or [])]
    return products, snapshot_map, rates, fx_ids


def _availability_from_record(item: dict) -> str:
    raw = item.get("availability")
    if raw in {"in_stock", "limited", "out_of_stock", "unknown"}:
        return str(raw)
    status = item.get("availability_status")
    if status in {"in_stock", "limited", "out_of_stock"}:
        return str(status)
    if item.get("in_stock") is True:
        return "in_stock"
    if item.get("in_stock") is False:
        return "out_of_stock"
    return "unknown"


def _hydrate_stock(item: dict) -> tuple[bool | None, str | None]:
    if isinstance(item.get("in_stock"), bool):
        in_stock = item["in_stock"]
        status = item.get("availability_status") or ("in_stock" if in_stock else "out_of_stock")
        return in_stock, str(status)
    label = item.get("availability") or item.get("availability_status")
    if label == "in_stock":
        return True, "in_stock"
    if label == "out_of_stock":
        return False, "out_of_stock"
    if label == "limited":
        return True, "limited"
    return None, None


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
