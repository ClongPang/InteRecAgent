from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

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


def normalize_item(item: RawProduct) -> NormalizedProduct:
    """真实字段白名单映射。API 缺失的字段（rating/规格/库存等）显式标记 unavailable，
    不填默认值——遵循"不伪造字段"原则。"""
    price = item.price
    in_stock, status = _availability(getattr(item, "availability", None))
    unavailable = [name for name in API_MISSING_FIELDS]
    if in_stock is None:
        unavailable.append("availability")
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
        unavailable=unavailable,
    )
    return derive_title_attrs(product)


def _availability(raw: object | None) -> tuple[bool | None, str | None]:
    if not isinstance(raw, dict):
        in_stock = getattr(raw, "in_stock", None)
        status = getattr(raw, "status", None)
    else:
        in_stock = raw.get("in_stock")
        status = raw.get("status")
    if isinstance(in_stock, bool):
        return in_stock, str(status) if status else ("in_stock" if in_stock else "out_of_stock")
    if isinstance(status, str) and status:
        return status in {"in_stock", "limited"}, status
    return None, None
