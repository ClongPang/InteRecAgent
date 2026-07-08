import json

import pytest

from backend.app.services.product_store import ProductStore, load_catalog_artifact
from backend.app.services.retriever import Retriever
from backend.app.services.task_router import TaskRouter
from backend.app.services.intent_parser import IntentParser


def write_catalog(path, rows):
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def test_product_store_loads_normalized_catalog_artifact(tmp_path):
    catalog_path = tmp_path / "normalized_catalog.jsonl"
    write_catalog(
        catalog_path,
        [
            {
                "product_id": "artifact_mouse_001",
                "title": "Artifact Quiet Office Mouse",
                "brand": "DeskLab",
                "price": 29.99,
                "category_path": ["Electronics", "Mouse"],
                "leaf_category": "Wireless Mouse",
                "matched_tags": ["quiet", "office"],
                "evidence": [
                    {
                        "source": "review",
                        "product_id": "artifact_mouse_001",
                        "text": "Reviewers mention quiet office use.",
                    }
                ],
                "rank": 0,
            }
        ],
    )

    store = ProductStore(catalog_path=catalog_path)

    assert store.source == str(catalog_path)
    assert store.get("artifact_mouse_001").title == "Artifact Quiet Office Mouse"
    assert store.get("prod_headphones_001") is None


def test_product_store_uses_env_catalog_path(monkeypatch, tmp_path):
    catalog_path = tmp_path / "env_catalog.jsonl"
    write_catalog(
        catalog_path,
        [
            {
                "product_id": "env_headphones_001",
                "title": "Env Loaded Wireless Headphones",
                "price": 88.0,
                "category_path": ["Electronics", "Headphones"],
                "leaf_category": "Wireless Headphones",
                "rank": 0,
            }
        ],
    )
    monkeypatch.setenv("INTEREC_CATALOG_PATH", str(catalog_path))

    store = ProductStore()

    assert store.source == str(catalog_path)
    assert store.get("env_headphones_001") is not None


def test_product_store_falls_back_to_demo_catalog_when_artifact_missing(tmp_path):
    store = ProductStore(catalog_path=tmp_path / "missing.jsonl")

    assert store.source == "demo_fixture"
    assert store.get("prod_headphones_001") is not None


def test_catalog_artifact_validation_reports_line_number(tmp_path):
    catalog_path = tmp_path / "broken.jsonl"
    catalog_path.write_text('{"product_id":"missing required fields"}\n', encoding="utf-8")

    with pytest.raises(ValueError, match=r"broken\.jsonl:1"):
        load_catalog_artifact(catalog_path)


def test_retriever_uses_products_from_catalog_artifact(tmp_path):
    catalog_path = tmp_path / "normalized_catalog.jsonl"
    write_catalog(
        catalog_path,
        [
            {
                "product_id": "artifact_mouse_001",
                "title": "Artifact Quiet Office Mouse",
                "price": 29.99,
                "category_path": ["Electronics", "Mouse"],
                "leaf_category": "Wireless Mouse",
                "matched_tags": ["quiet", "office"],
                "rank": 0,
            },
            {
                "product_id": "artifact_headphones_001",
                "title": "Artifact Wireless Headphones",
                "price": 79.99,
                "category_path": ["Electronics", "Headphones"],
                "leaf_category": "Wireless Headphones",
                "rank": 0,
            },
        ],
    )
    route = TaskRouter().route("Recommend a quiet office mouse")
    intent = IntentParser().parse("Recommend a quiet office mouse", route)

    results = Retriever(ProductStore(catalog_path=catalog_path)).retrieve(intent)

    assert [product.product_id for product in results] == ["artifact_mouse_001"]
