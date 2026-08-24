"""对外 ViewModel 投影测试（规格 §6.2–6.5），离线、不连库。"""
from __future__ import annotations

from datetime import UTC, datetime

from backend.application.dto import ShoppingMission, mission_view
from backend.application.dto.runner import RecommendationDraft
from backend.application.services.present import (
    candidate_record,
    https_url,
    hydrate_candidate_payload,
    image_url_of,
    product_candidate_from_record,
    product_candidate_from_snapshot,
    remap_draft,
)
from backend.application.services.rec.identity import (
    merchant_page_url,
    page_key,
    unwrap_merchant_url,
)
from backend.domain.models import FxSnapshot, NormalizedProduct


def _product() -> NormalizedProduct:
    return NormalizedProduct(
        id="src-1",
        title="Sony WH-1000XM5",
        merchant="shopify",
        country_code="US",
        url="https://example.com/p",
        click_url="http://insecure.example/p",
        image_url="https://cdn.example/sony.jpg",
        native_price_amount=100.0,
        native_currency="USD",
        rmb_price=720.0,
        fx_as_of="2026-08-15",
        fx_failed=False,
        unavailable=["rating"],
        updated_at=datetime(2026, 6, 16, tzinfo=UTC),
    )


def test_mission_view_omits_owner_id() -> None:
    mission = ShoppingMission(id="m1", owner_id="owner-1", title="选购")
    view = mission_view(mission)
    dumped = view.model_dump()
    assert "owner_id" not in dumped
    assert dumped["id"] == "m1"


def test_unwrap_merchant_url_rejects_click_wrapper() -> None:
    click = (
        "https://buywhere.ai/api/click?url=https%3A%2F%2Fwww.decathlon.com"
        "%2Fproducts%2Fquechua-mens-mh100-hiking-shoes-307854&product_id=1"
    )
    page = "https://www.decathlon.com/products/quechua-mens-mh100-hiking-shoes-307854"
    assert unwrap_merchant_url(click) == page
    assert unwrap_merchant_url(page) == page
    assert unwrap_merchant_url("https://buywhere.ai/api/click?product_id=1") is None
    assert merchant_page_url(None, click) == page
    assert page_key(click) == "page:decathlon.com/products/quechua-mens-mh100-hiking-shoes-307854"


def test_https_url_rejects_http() -> None:
    assert https_url("https://ok.example/a") == "https://ok.example/a"
    assert https_url("http://no.example/a") is None


def test_image_url_of_falls_back_to_snapshot() -> None:
    record = {"title": "Sony"}
    snap = {"normalized": {"image_url": "https://cdn.example/p.jpg"}}
    assert image_url_of(record, snap) == "https://cdn.example/p.jpg"
    assert image_url_of({"image_url": "https://ok.example/a.jpg"}, snap) == "https://ok.example/a.jpg"
    assert image_url_of({"image_url": "http://insecure.example/a.jpg"}, snap) == "https://cdn.example/p.jpg"
    assert image_url_of(record) is None


def test_candidate_record_unwraps_buywhere_click() -> None:
    product = _product().model_copy(
        update={
            "url": None,
            "click_url": (
                "https://buywhere.ai/api/click?url=https%3A%2F%2Fwww.decathlon.com"
                "%2Fproducts%2Fquechua-mens-mh100-hiking-shoes-307854&product_id=1"
            ),
        }
    )
    fx = FxSnapshot(base="USD", quote="CNY", rate=7.2, date="2026-08-15", source="frankfurter-ecb")
    record = candidate_record(product, snapshot_id="snap-uuid", fx=fx, rank=1, budget_cny=1000)
    assert record["merchant_url"] == "https://www.decathlon.com/products/quechua-mens-mh100-hiking-shoes-307854"
    candidate = product_candidate_from_record(
        {**record, "merchant_url": product.click_url}
    )
    assert candidate is not None
    assert candidate.merchant_url == record["merchant_url"]


def test_candidate_record_uses_snapshot_id_and_https_merchant_url() -> None:
    fx = FxSnapshot(base="USD", quote="CNY", rate=7.2, date="2026-08-15", source="frankfurter-ecb")
    record = candidate_record(_product(), snapshot_id="snap-uuid", fx=fx, rank=1, budget_cny=1000)
    assert record["snapshot_id"] == "snap-uuid"
    assert record["source_product_id"] == "src-1"
    assert record["merchant_url"] == "https://example.com/p"
    assert record["image_url"] == "https://cdn.example/sony.jpg"
    assert record["estimated_cny"]["rate"] == 7.2
    assert "within_budget" in record["decision_reasons"]
    candidate = product_candidate_from_record(record)
    assert candidate is not None
    assert candidate.snapshot_id == "snap-uuid"
    assert candidate.image_url == "https://cdn.example/sony.jpg"
    assert candidate.availability == "unknown"


def test_candidate_record_keeps_stock_and_derived_brand() -> None:
    fx = FxSnapshot(base="USD", quote="CNY", rate=7.2, date="2026-08-15", source="frankfurter-ecb")
    product = _product().model_copy(
        update={
            "in_stock": True,
            "availability_status": "in_stock",
            "stock_source": "metadata",
            "attrs": {"brand": "Sony"},
            "derived_fields": ["brand"],
        }
    )
    record = candidate_record(product, snapshot_id="snap-uuid", fx=fx, rank=1, budget_cny=1000)
    assert record["availability"] == "in_stock"
    assert record["stock_source"] == "metadata"
    assert "merchant_marked_in_stock" in record["decision_reasons"]
    assert record["brand"] == "Sony"
    assert "brand" in record["derived_fields"]
    candidate = product_candidate_from_record(record)
    assert candidate is not None
    assert candidate.availability == "in_stock"
    assert candidate.stock_source == "metadata"
    assert candidate.brand == "Sony"
    products, *_ = hydrate_candidate_payload(
        {"ranked": [record], "snapshot_map": {"src-1": "snap-uuid"}}
    )
    assert products[0].in_stock is True
    assert products[0].stock_source == "metadata"
    assert products[0].attrs.get("brand") == "Sony"


def test_legacy_ranked_item_still_maps() -> None:
    item = {
        "id": "src-1",
        "snapshot_id": "snap-uuid",
        "title": "Sony",
        "native_price_amount": 10.0,
        "native_currency": "USD",
        "rmb_price": 72.0,
        "fx_failed": False,
        "fx_as_of": "2026-08-15",
    }
    candidate = product_candidate_from_record(item, rank=2)
    assert candidate is not None
    assert "source_product_id" not in candidate.model_dump()
    assert candidate.rank == 2
    assert candidate.estimated_cny is not None


def test_remap_draft_rewrites_source_ids_to_snapshot_uuids() -> None:
    draft = RecommendationDraft(
        primary_snapshot_id="src-1",
        alternative_snapshot_ids=["src-2"],
        cited_evidence_ids=["src-1", "src-2"],
        rationale=["低价"],
        tradeoffs=["库存未知"],
    )
    remapped = remap_draft(draft, {"src-1": "snap-a", "src-2": "snap-b"})
    assert remapped.primary_snapshot_id == "snap-a"
    assert remapped.alternative_snapshot_ids == ["snap-b"]
    assert remapped.cited_evidence_ids == ["snap-a", "snap-b"]


def test_snapshot_envelope_maps_to_candidate() -> None:
    candidate = product_candidate_from_snapshot(
        {
            "id": "snap-uuid",
            "source": "buywhere",
            "source_product_id": "src-1",
            "normalized": _product().model_dump(mode="json"),
        }
    )
    assert candidate is not None
    assert candidate.snapshot_id == "snap-uuid"
    assert "source_product_id" not in candidate.model_dump()
    assert candidate.image_url == "https://cdn.example/sony.jpg"
