import json
from pathlib import Path

from backend.app.data_pipeline.demo_pool import select_demo_pool
from backend.app.data_pipeline.metadata_loader import load_metadata
from backend.app.data_pipeline.quality_report import build_quality_report
from backend.app.data_pipeline.review_loader import attach_review_evidence, load_review_evidence


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")


def test_metadata_loader_normalizes_jsonl_rows(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    write_jsonl(
        metadata_path,
        [
            {
                "asin": "A1",
                "title": "Wireless Headphones",
                "brand": "AeroLite",
                "price": "$79.99",
                "categories": [["Electronics", "Headphones"]],
                "image": "https://example.test/image.jpg",
            }
        ],
    )

    products = load_metadata(metadata_path)

    assert products[0].product_id == "A1"
    assert products[0].price == 79.99
    assert products[0].leaf_category == "Headphones"


def test_review_loader_attaches_evidence_and_unknown_state(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    write_jsonl(
        metadata_path,
        [
            {"asin": "A1", "title": "Wireless Headphones", "price": 79.99},
            {"asin": "A2", "title": "Mystery Headphones"},
        ],
    )
    write_jsonl(review_path, [{"asin": "A1", "reviewText": "Comfortable for long commutes."}])

    products = load_metadata(metadata_path)
    evidence = load_review_evidence(review_path)
    enriched = attach_review_evidence(products, evidence)

    assert enriched[0].evidence[0].text == "Comfortable for long commutes."
    assert "review evidence missing" in enriched[1].uncertainties


def test_quality_report_and_demo_pool_prioritize_complete_products(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    write_jsonl(
        metadata_path,
        [
            {
                "asin": "A1",
                "title": "Complete Product",
                "brand": "AeroLite",
                "price": 79.99,
                "categories": [["Electronics", "Headphones"]],
                "image": "https://example.test/image.jpg",
                "average_rating": 4.8,
            },
            {"asin": "A2", "title": "Sparse Product"},
        ],
    )
    write_jsonl(review_path, [{"asin": "A1", "reviewText": "Strong evidence."}])

    enriched = attach_review_evidence(load_metadata(metadata_path), load_review_evidence(review_path))
    report = build_quality_report(enriched)
    demo_pool = select_demo_pool(enriched, limit=1)

    assert report["product_count"] == 2
    assert report["price_coverage"] == 0.5
    assert report["evidence_coverage"] == 0.5
    assert demo_pool[0].product_id == "A1"
