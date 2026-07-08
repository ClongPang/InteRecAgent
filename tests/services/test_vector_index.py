import json

from backend.app.services.intent_parser import IntentParser
from backend.app.services.product_store import ProductStore
from backend.app.services.retriever import Retriever
from backend.app.services.task_router import TaskRouter
from backend.app.services.vector_index import (
    DeterministicVectorIndex,
    intent_query_text,
    load_vector_index_artifact,
    product_embedding_text,
    product_index_row,
)


def test_product_embedding_text_includes_metadata_tags_and_evidence():
    product = ProductStore(load_default_artifact=False).get("prod_headphones_001")
    assert product is not None

    text = product_embedding_text(product).lower()

    assert "aerolite wireless commuter headphones" in text
    assert "commuting" in text
    assert "comfortable" in text
    assert "reviewers repeatedly mention" in text


def test_deterministic_vector_index_returns_stable_relevance_order():
    products = ProductStore(load_default_artifact=False).list()
    index = DeterministicVectorIndex(products)

    hits = index.search("quiet office mouse", top_k=3)

    assert hits[0].product_id == "prod_mouse_001"
    assert hits[0].score > hits[1].score


def test_retriever_uses_intent_query_text_and_keeps_category_filter():
    route = TaskRouter().route("Recommend a quiet office mouse")
    intent = IntentParser().parse("Recommend a quiet office mouse", route)
    query = intent_query_text(intent)

    results = Retriever(ProductStore(load_default_artifact=False)).retrieve(intent, top_k=2)

    assert "mouse" in query
    assert [product.product_id for product in results] == ["prod_mouse_001"]


def test_retriever_returns_headphones_by_vector_order_with_top_k():
    route = TaskRouter().route("Recommend compact portable wireless headphones")
    intent = IntentParser().parse("Recommend compact portable wireless headphones", route)

    results = Retriever(ProductStore(load_default_artifact=False)).retrieve(intent, top_k=2)

    assert len(results) == 2
    assert results[0].product_id == "prod_headphones_002"
    assert all("headphone" in product.title.lower() for product in results)


def test_vector_index_artifact_round_trips_tokens(tmp_path):
    product = ProductStore(load_default_artifact=False).get("prod_mouse_001")
    assert product is not None
    index_path = tmp_path / "product_index.jsonl"
    index_path.write_text(json.dumps(product_index_row(product)) + "\n", encoding="utf-8")

    vectors = load_vector_index_artifact(index_path)
    index = DeterministicVectorIndex(vectors=vectors)

    assert "prod_mouse_001" in vectors
    assert index.search("quiet office mouse", top_k=1)[0].product_id == "prod_mouse_001"


def test_retriever_uses_vector_index_artifact_when_available(tmp_path):
    store = ProductStore(load_default_artifact=False)
    products = store.list()
    index_path = tmp_path / "product_index.jsonl"
    index_path.write_text(
        "\n".join(json.dumps(product_index_row(product)) for product in products) + "\n",
        encoding="utf-8",
    )
    route = TaskRouter().route("Recommend a quiet office mouse")
    intent = IntentParser().parse("Recommend a quiet office mouse", route)

    retriever = Retriever(store, index_path=index_path)
    results = retriever.retrieve(intent, top_k=2)

    assert retriever.index_source == str(index_path)
    assert results[0].product_id == "prod_mouse_001"
