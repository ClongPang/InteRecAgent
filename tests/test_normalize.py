from __future__ import annotations

from backend.domain.models import API_MISSING_FIELDS
from backend.domain.policies.normalize import normalize_item
from backend.infrastructure.product_sources.buywhere import BuyWherePrice, BuyWhereProduct


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
    p = normalize_item(_item())
    assert p.id == "p1"
    assert p.native_price_amount == 499.99
    assert p.native_currency == "USD"
    assert p.merchant == "shopify"
    assert p.country_code == "US"
    assert p.updated_at is not None
    assert p.updated_at.isoformat() == "2026-06-11T17:05:52.850000+00:00"


def test_missing_fields_marked_unavailable():
    p = normalize_item(_item())
    assert set(p.unavailable) == set(API_MISSING_FIELDS) | {"availability"}
    assert "rating" in p.unavailable
    assert "structured_specs" in p.unavailable
    assert "availability" in p.unavailable
    assert p.in_stock is None


def test_availability_is_normalized_when_present():
    p = normalize_item(_item(availability={"in_stock": True, "status": "in_stock"}))
    assert p.in_stock is True
    assert p.availability_status == "in_stock"
    assert "availability" not in p.unavailable
    assert p.attrs.get("brand") == "Sony"
    assert "brand" in p.derived_fields


def test_nullable_fields_stay_none():
    p = normalize_item(_item(region=None, image_url=None))
    assert p.region is None
    assert p.image_url is None
