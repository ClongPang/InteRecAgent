from __future__ import annotations

from backend.adapters.buywhere import BuyWherePrice, BuyWhereProduct
from backend.domain.models import API_MISSING_FIELDS
from backend.domain.normalize import normalize_buywhere_item


def _item(**overrides) -> BuyWhereProduct:
    base = dict(
        id="p1",
        title="Sony WH-1000XM5 Wireless Noise Cancelling Headphones - Black",
        price=BuyWherePrice(amount=499.99, currency="USD"),
        merchant="shopify",
        country_code="US",
        url="https://example.com/p1",
        updated_at="2026-06-11T17:05:52.850Z",
    )
    base.update(overrides)
    return BuyWhereProduct.model_validate(base)


def test_real_fields_mapped():
    p = normalize_buywhere_item(_item())
    assert p.id == "p1"
    assert p.native_price_amount == 499.99
    assert p.native_currency == "USD"
    assert p.merchant == "shopify"
    assert p.country_code == "US"
    assert p.updated_at is not None
    assert p.updated_at.isoformat() == "2026-06-11T17:05:52.850000+00:00"


def test_missing_fields_marked_unavailable():
    p = normalize_buywhere_item(_item())
    # 文档/前端 mock 假设的 rating/specs/availability 等，真实 API 提供不了，显式标记
    assert set(p.unavailable) == set(API_MISSING_FIELDS)
    assert "rating" in p.unavailable
    assert "structured_specs" in p.unavailable


def test_nullable_fields_stay_none():
    p = normalize_buywhere_item(_item(region=None, image_url=None))
    assert p.region is None
    assert p.image_url is None
