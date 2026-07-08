import gzip
import json
from pathlib import Path

from backend.app.data_pipeline.catalog_builder import (
    CatalogBuildConfig,
    build_catalog,
    write_catalog_artifacts,
)
from backend.app.data_pipeline.catalog_readiness import check_catalog_readiness
from backend.app.data_pipeline.demo_pool import select_demo_pool
from backend.app.data_pipeline.metadata_loader import load_metadata
from backend.app.data_pipeline.profile_builder import (
    ProfileBuildConfig,
    build_user_profiles,
    write_profile_artifacts,
)
from backend.app.data_pipeline.profile_readiness import check_profile_readiness
from backend.app.data_pipeline.quality_report import build_quality_report
from backend.app.data_pipeline.review_loader import attach_review_evidence, load_review_evidence
from backend.app.data_pipeline.vector_index_builder import (
    build_vector_index,
    write_vector_index_artifacts,
)
from backend.app.data_pipeline.vector_index_readiness import check_vector_index_readiness


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")


def write_jsonl_gz(path: Path, rows: list[dict]) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(json.dumps(row) for row in rows))


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


def test_metadata_loader_accepts_amazon_metadata_variant_fields(tmp_path):
    metadata_path = tmp_path / "amazon_metadata.jsonl"
    write_jsonl(
        metadata_path,
        [
            {
                "asin": "AMZ1",
                "title": "Amazon Variant Product",
                "brand": "VariantBrand",
                "price": "Currently unavailable",
                "category": ["Electronics", "Computer Accessories", "Mouse"],
                "imageURLHighRes": [
                    "https://example.test/high-res.jpg",
                    "https://example.test/backup.jpg",
                ],
                "feature": ["Quiet click buttons", "Ergonomic shape"],
                "description": ["Designed for long office sessions."],
            }
        ],
    )

    product = load_metadata(metadata_path)[0]

    assert product.price is None
    assert product.image_url == "https://example.test/high-res.jpg"
    assert product.category_path == ["Electronics", "Computer Accessories", "Mouse"]
    assert product.leaf_category == "Mouse"
    assert "Quiet click buttons" in product.matched_tags
    assert product.evidence[0].source == "metadata"
    assert product.evidence[0].text == "Quiet click buttons"


def test_catalog_builder_accepts_gzipped_amazon_jsonl(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl.gz"
    review_path = tmp_path / "reviews.jsonl.gz"
    write_jsonl_gz(
        metadata_path,
        [
            {
                "asin": "GZ1",
                "title": "Gzip Quiet Office Mouse",
                "brand": "ZipDesk",
                "price": "$25.50",
                "categories": [["Electronics", "Mouse"]],
                "image": "https://example.test/gz.jpg",
            }
        ],
    )
    write_jsonl_gz(review_path, [{"asin": "GZ1", "reviewText": "Quiet and reliable at work."}])

    result = build_catalog(
        metadata_path,
        review_path,
        CatalogBuildConfig(target_min_products=1, target_max_products=2, demo_pool_limit=1),
    )

    assert result.scale_status == "target_met"
    assert result.products[0].product_id == "GZ1"
    assert result.products[0].price == 25.5
    assert result.products[0].evidence[0].text == "Quiet and reliable at work."


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


def test_review_loader_preserves_metadata_evidence(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    write_jsonl(
        metadata_path,
        [
            {
                "asin": "A1",
                "title": "Wireless Headphones",
                "feature": ["Metadata comfort feature."],
            },
        ],
    )
    write_jsonl(review_path, [{"asin": "A1", "reviewText": "Review comfort evidence."}])

    enriched = attach_review_evidence(load_metadata(metadata_path), load_review_evidence(review_path))

    assert [item.source for item in enriched[0].evidence] == ["metadata", "review"]
    assert [item.text for item in enriched[0].evidence] == [
        "Metadata comfort feature.",
        "Review comfort evidence.",
    ]


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


def test_catalog_builder_reports_below_target_for_small_fixture(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    output_dir = tmp_path / "catalog"
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
            }
        ],
    )
    write_jsonl(review_path, [{"asin": "A1", "reviewText": "Useful evidence."}])

    result = build_catalog(
        metadata_path,
        review_path,
        CatalogBuildConfig(target_min_products=2, target_max_products=3, demo_pool_limit=1),
    )
    write_catalog_artifacts(result, output_dir)

    assert result.scale_status == "below_target"
    assert result.quality_report["source_product_count"] == 1
    assert result.demo_pool[0].product_id == "A1"
    assert "target minimum is 2" in result.warnings[0]
    assert (output_dir / "normalized_catalog.jsonl").read_text(encoding="utf-8").count("\n") == 1
    assert json.loads((output_dir / "quality_report.json").read_text(encoding="utf-8"))[
        "scale_status"
    ] == "below_target"


def test_catalog_builder_caps_to_target_max_and_filters_reviews(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    write_jsonl(
        metadata_path,
        [
            {"asin": "A1", "title": "First", "price": 20, "categories": [["Electronics", "Mouse"]]},
            {"asin": "A2", "title": "Second", "price": 30, "categories": [["Electronics", "Mouse"]]},
            {"asin": "A3", "title": "Third", "price": 40, "categories": [["Electronics", "Mouse"]]},
        ],
    )
    write_jsonl(
        review_path,
        [
            {"asin": "A1", "reviewText": "Kept evidence."},
            {"asin": "A3", "reviewText": "Filtered evidence."},
        ],
    )

    result = build_catalog(
        metadata_path,
        review_path,
        CatalogBuildConfig(target_min_products=2, target_max_products=2, demo_pool_limit=2),
    )

    assert result.scale_status == "target_met"
    assert result.source_product_count == 3
    assert [product.product_id for product in result.products] == ["A1", "A2"]
    assert result.products[0].evidence[0].text == "Kept evidence."
    assert all(product.product_id != "A3" for product in result.products)
    assert "eligible catalog capped from 3 to 2" in result.warnings[0]


def test_catalog_builder_filters_rows_missing_title_or_category(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    write_jsonl(
        metadata_path,
        [
            {"asin": "NO_TITLE", "categories": [["Electronics", "Mouse"]]},
            {"asin": "NO_CATEGORY", "title": "Missing Category"},
            {"asin": "READY", "title": "Ready Product", "categories": [["Electronics", "Mouse"]]},
        ],
    )

    result = build_catalog(
        metadata_path,
        None,
        CatalogBuildConfig(target_min_products=1, target_max_products=2, demo_pool_limit=1),
    )

    assert result.source_product_count == 3
    assert result.filtered_product_count == 2
    assert result.quality_report["filtered_product_count"] == 2
    assert [product.product_id for product in result.products] == ["READY"]
    assert "filtered 2 metadata rows missing title or category" in result.warnings[0]


def test_catalog_readiness_passes_for_complete_artifacts(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    artifact_dir = tmp_path / "catalog"
    write_jsonl(
        metadata_path,
        [
            {
                "asin": "A1",
                "title": "Ready Product",
                "brand": "ReadyBrand",
                "price": 25,
                "categories": [["Electronics", "Mouse"]],
                "image": "https://example.test/a1.jpg",
            },
            {
                "asin": "A2",
                "title": "Ready Product Two",
                "brand": "ReadyBrand",
                "price": 35,
                "categories": [["Electronics", "Headphones"]],
                "image": "https://example.test/a2.jpg",
            },
        ],
    )
    write_jsonl(
        review_path,
        [
            {"asin": "A1", "reviewText": "Strong ready evidence."},
            {"asin": "A2", "reviewText": "More ready evidence."},
        ],
    )
    config = CatalogBuildConfig(target_min_products=2, target_max_products=3, demo_pool_limit=2)
    write_catalog_artifacts(build_catalog(metadata_path, review_path, config), artifact_dir)

    report = check_catalog_readiness(artifact_dir, config)

    assert report.ready is True
    assert report.product_count == 2
    assert report.demo_pool_count == 2
    assert report.scale_status == "target_met"
    assert report.errors == []


def test_catalog_readiness_fails_for_missing_artifacts(tmp_path):
    report = check_catalog_readiness(
        tmp_path / "missing_catalog",
        CatalogBuildConfig(target_min_products=2, target_max_products=3, demo_pool_limit=2),
    )

    assert report.ready is False
    assert any("normalized catalog is missing" in error for error in report.errors)
    assert any("quality report is missing" in error for error in report.errors)


def test_catalog_readiness_detects_quality_report_mismatch(tmp_path):
    metadata_path = tmp_path / "metadata.jsonl"
    artifact_dir = tmp_path / "catalog"
    write_jsonl(
        metadata_path,
        [
            {"asin": "A1", "title": "Mismatch One", "price": 25, "categories": [["Electronics", "Mouse"]]},
            {"asin": "A2", "title": "Mismatch Two", "price": 35, "categories": [["Electronics", "Mouse"]]},
        ],
    )
    config = CatalogBuildConfig(target_min_products=2, target_max_products=3, demo_pool_limit=2)
    write_catalog_artifacts(build_catalog(metadata_path, None, config), artifact_dir)
    (artifact_dir / "quality_report.json").write_text(
        json.dumps(
            {
                "product_count": 1,
                "source_product_count": 2,
                "scale_status": "below_target",
                "price_coverage": 1.0,
                "image_coverage": 0.0,
                "brand_coverage": 0.0,
                "category_coverage": 0.0,
                "evidence_coverage": 0.0,
            }
        ),
        encoding="utf-8",
    )

    report = check_catalog_readiness(artifact_dir, config)

    assert report.ready is False
    assert "quality report product_count does not match normalized catalog" in report.errors
    assert "quality report scale_status must be target_met" in report.errors


def test_profile_builder_aggregates_review_behavior_with_catalog_categories(tmp_path):
    catalog_path = tmp_path / "normalized_catalog.jsonl"
    review_path = tmp_path / "reviews.jsonl"
    output_dir = tmp_path / "profiles"
    catalog_path.write_text(
        "\n".join(
            [
                '{"product_id":"P1","title":"Mouse","category_path":["Electronics","Mouse"],"leaf_category":"Mouse","rank":0}',
                '{"product_id":"P2","title":"Headphones","category_path":["Electronics","Headphones"],"leaf_category":"Headphones","rank":0}',
                '{"product_id":"P3","title":"Speaker","category_path":["Electronics","Speaker"],"leaf_category":"Speaker","rank":0}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    write_jsonl(
        review_path,
        [
            {"reviewerID": "U1", "asin": "P1", "overall": 5, "unixReviewTime": 30},
            {"reviewerID": "U1", "asin": "P2", "overall": 2, "unixReviewTime": 20},
            {"reviewerID": "U2", "asin": "P3", "overall": 4, "unixReviewTime": 10},
        ],
    )

    result = build_user_profiles(
        review_path,
        catalog_path,
        ProfileBuildConfig(min_reviews_per_user=2, max_profiles=10),
    )
    write_profile_artifacts(result, output_dir)
    readiness = check_profile_readiness(output_dir, min_profiles=1)

    assert result.summary["source_user_count"] == 2
    assert result.summary["profile_count"] == 1
    assert result.profiles[0]["user_id"] == "U1"
    assert result.profiles[0]["average_rating"] == 3.5
    assert result.profiles[0]["positive_product_ids"] == ["P1"]
    assert result.profiles[0]["negative_product_ids"] == ["P2"]
    assert result.profiles[0]["recent_product_ids"] == ["P1", "P2"]
    assert result.profiles[0]["preferred_categories"][0]["category"] == "Mouse"
    assert readiness.ready is True


def test_profile_readiness_fails_for_missing_artifacts(tmp_path):
    report = check_profile_readiness(tmp_path / "missing_profiles", min_profiles=1)

    assert report.ready is False
    assert any("user profiles are missing" in error for error in report.errors)
    assert any("profile summary is missing" in error for error in report.errors)


def test_vector_index_builder_writes_searchable_artifacts(tmp_path):
    catalog_path = tmp_path / "normalized_catalog.jsonl"
    output_dir = tmp_path / "indexes"
    catalog_path.write_text(
        "\n".join(
            [
                '{"product_id":"P1","title":"Quiet Office Mouse","brand":"DeskLab","category_path":["Electronics","Mouse"],"leaf_category":"Mouse","matched_tags":["quiet","office"],"rank":0}',
                '{"product_id":"P2","title":"Wireless Headphones","brand":"SoundLab","category_path":["Electronics","Headphones"],"leaf_category":"Headphones","matched_tags":["wireless"],"rank":0}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    result = build_vector_index(catalog_path)
    write_vector_index_artifacts(result, output_dir)
    readiness = check_vector_index_readiness(output_dir, min_products=2)

    assert result.manifest["product_count"] == 2
    assert result.manifest["index_type"] == "deterministic_token_jaccard"
    assert (output_dir / "product_index.jsonl").read_text(encoding="utf-8").count("\n") == 2
    assert readiness.ready is True
    assert readiness.product_count == 2


def test_vector_index_readiness_fails_for_missing_artifacts(tmp_path):
    report = check_vector_index_readiness(tmp_path / "missing_indexes", min_products=1)

    assert report.ready is False
    assert any("vector index is missing" in error for error in report.errors)
    assert any("index manifest is missing" in error for error in report.errors)
