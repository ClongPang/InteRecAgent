from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from ..models import API_MISSING_FIELDS, NormalizedProduct
from .derive_attrs import derive_title_attrs


@runtime_checkable
class RawProductPrice(Protocol):
    """供应商商品价格的最小结构。领域层只依赖此协议，不依赖具体供应商模型。"""

    amount: float | None
    currency: str | None


@runtime_checkable
class RawProduct(Protocol):
    """供应商商品响应的最小结构（结构化鸭子类型）。供应商模型在 Infrastructure 层
    满足此协议即可进入领域归一化，领域层不 import 任何供应商代码。"""

    id: str
    title: str
    price: RawProductPrice | None
    merchant: str | None
    url: str | None
    image_url: str | None
    region: str | None
    country_code: str | None
    updated_at: str | None
    click_url: str | None
    availability: object | None = None
    metadata: object | None = None


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_item(item: Any) -> NormalizedProduct:
    """真实字段白名单映射。API 缺失的字段（rating/规格/库存等）显式标记 unavailable，
    不填默认值——遵循"不伪造字段"原则。"""
    price = item.price
    in_stock, status, stock_source = stock_signal_of(item)
    unavailable = [name for name in API_MISSING_FIELDS]
    if in_stock is None:
        unavailable.append("availability")
    observed_attrs = _metadata_attrs(getattr(item, "metadata", None))
    product = NormalizedProduct(
        id=item.id,
        title=item.title,
        merchant=item.merchant,
        country_code=item.country_code,
        region=item.region,
        url=item.url,
        click_url=item.click_url,
        image_url=item.image_url,
        updated_at=_parse_iso(item.updated_at),
        native_price_amount=price.amount if price else None,
        native_currency=price.currency if price else None,
        in_stock=in_stock,
        availability_status=status,
        stock_source=stock_source,
        attrs=observed_attrs,
        unavailable=[name for name in unavailable if name != "brand" or "brand" not in observed_attrs],
    )
    return derive_title_attrs(product)


def _metadata_attrs(raw: object | None) -> dict[str, str]:
    """Preserve only BuyWhere metadata fields that carry product semantics."""
    if not isinstance(raw, dict):
        return {}
    attrs: dict[str, str] = {}
    for key in ("brand", "vendor", "category", "product_type"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            attrs[key] = value.strip()
    tags = raw.get("tags")
    if isinstance(tags, list):
        clean = [str(value).strip() for value in tags if str(value).strip()]
        if clean:
            attrs["tags"] = " | ".join(clean[:50])
    return attrs


_STATUS = {
    "in_stock": (True, "in_stock"),
    "available": (True, "in_stock"),
    "limited": (True, "limited"),
    "low_stock": (True, "limited"),
    "out_of_stock": (False, "out_of_stock"),
    "unavailable": (False, "out_of_stock"),
    "sold_out": (False, "out_of_stock"),
}


def stock_signal_of(item: RawProduct) -> tuple[bool | None, str | None, str | None]:
    """顶层 availability 优先；否则读 metadata 白名单。冲突或无法识别则未知。"""
    raw = getattr(item, "availability", None)
    if _top_level_present(raw):
        in_stock, status = _from_top_level(raw)
        return in_stock, status, "top_level" if in_stock is not None or status else None
    in_stock, status = _from_metadata(getattr(item, "metadata", None))
    if in_stock is not None or status:
        return in_stock, status, "metadata"
    return None, None, None


def _top_level_present(raw: object | None) -> bool:
    if raw is None:
        return False
    if isinstance(raw, dict):
        return raw.get("in_stock") is not None or bool(raw.get("status") or raw.get("availability"))
    return getattr(raw, "in_stock", None) is not None or bool(getattr(raw, "status", None))


def _from_top_level(raw: object | None) -> tuple[bool | None, str | None]:
    if raw is None:
        return None, None
    if isinstance(raw, dict):
        return _merge(raw.get("in_stock"), _from_status(raw.get("status") or raw.get("availability")))
    return _merge(getattr(raw, "in_stock", None), _from_status(getattr(raw, "status", None)))


def _from_metadata(raw: object | None) -> tuple[bool | None, str | None]:
    if not isinstance(raw, dict):
        return None, None
    flags = [raw.get("in_stock"), raw.get("is_available")]
    bools = [flag for flag in flags if isinstance(flag, bool)]
    if bools and any(flag != bools[0] for flag in bools):
        return None, None
    return _merge(bools[0] if bools else None, _from_status(raw.get("availability")))


def _from_status(raw: object | None) -> tuple[bool | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    key = raw.strip().lower().replace(" ", "_")
    return _STATUS.get(key, (None, None))


def _merge(flag: object, status: tuple[bool | None, str | None]) -> tuple[bool | None, str | None]:
    status_flag, label = status
    typed = flag if isinstance(flag, bool) else None
    if typed is not None and status_flag is not None and typed != status_flag:
        return None, None
    if typed is True:
        return True, label or "in_stock"
    if typed is False:
        return False, label or "out_of_stock"
    return status_flag, label
