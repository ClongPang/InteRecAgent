import os
from pathlib import Path

import pytest

from backend.app.data_pipeline.catalog_builder import CatalogBuildConfig
from backend.app.data_pipeline.catalog_readiness import check_catalog_readiness
from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.product_store import ProductStore


pytestmark = [pytest.mark.artifact, pytest.mark.integration]


def test_ready_catalog_artifact_drives_recommendation_runtime():
    artifact_dir = Path(os.getenv("INTEREC_ARTIFACT_DIR", "data/catalog"))
    catalog_path = artifact_dir / "normalized_catalog.jsonl"
    config = CatalogBuildConfig(
        target_min_products=int(os.getenv("INTEREC_TARGET_MIN", "20000")),
        target_max_products=int(os.getenv("INTEREC_TARGET_MAX", "50000")),
        demo_pool_limit=int(os.getenv("INTEREC_DEMO_LIMIT", "50")),
    )
    readiness = check_catalog_readiness(
        artifact_dir,
        config,
    )
    if not readiness.ready:
        pytest.skip(f"catalog artifact is not ready: {readiness.errors}")

    store = ProductStore(catalog_path=catalog_path)
    catalog_ids = {product.product_id for product in store.list()}

    response = ChatOrchestrator(product_store=store).run(
        ChatRequest(message="Recommend a catalog item with strong evidence."),
        allow_clarification=False,
    )

    assert response.status == "recommendations_ready"
    assert response.products
    assert response.trace_summary.retrieved_count > 0
    assert {product.product_id for product in response.products}.issubset(catalog_ids)
    assert all(product.constraint_status != "violated" for product in response.products)
