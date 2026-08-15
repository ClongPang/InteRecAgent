# scripts/build_category_kb.py
import json
import os
from pathlib import Path

import httpx
from opensearchpy import OpenSearch, helpers

CARDS_PATH = Path("data/category_cards.jsonl")
INDEX_NAME = "globex_category_kb"
VECTOR_DIM = 1024  # 与 Query 塔输出维度一致
OPENSEARCH_PASSWORD = os.environ.get("OPENSEARCH_PASSWORD") or os.environ.get("OPENSEARCH_PASS")

client = OpenSearch(
    hosts=[{"host": os.environ["OPENSEARCH_HOST"], "port": int(os.environ.get("OPENSEARCH_PORT", "9200"))}],
    http_auth=(os.environ["OPENSEARCH_USER"], OPENSEARCH_PASSWORD),
    use_ssl=False,
)

# 同一份索引同时存：结构化字段 + 全文字段（ik 分词） + KNN 向量字段
INDEX_MAPPING = {
    "settings": {"index": {"knn": True}},
    "mappings": {
        "properties": {
            "card_id":       {"type": "keyword"},
            "category":      {"type": "text", "analyzer": "ik_max_word"},
            "card_type":     {"type": "keyword"},
            "summary":       {"type": "text", "analyzer": "ik_max_word"},
            "raw_evidence":  {"type": "text", "analyzer": "ik_max_word"},
            "last_updated":  {"type": "date"},
            "confidence":    {"type": "float"},
            "content_vector": {
                "type": "knn_vector",
                "dimension": VECTOR_DIM,
                "method": {
                    "name":       "hnsw",
                    "engine":     "faiss",         # 底层 ANN 引擎
                    "space_type": "cosinesimil",   # 与 Query 塔 cosine 一致
                },
            },
        }
    }
}


async def encode(text: str) -> list[float]:
    """复用 Query 塔做 embedding（同模型避免分布偏移）。"""
    async with httpx.AsyncClient(timeout=5.0) as cli:
        r = await cli.post(
            os.environ["TOWER_QUERY_ENDPOINT"], json={"query": text},
        )
        r.raise_for_status()
        return r.json()["embedding"]


async def build():
    if not client.indices.exists(INDEX_NAME):
        client.indices.create(INDEX_NAME, body=INDEX_MAPPING)

    cards = [json.loads(l) for l in CARDS_PATH.open(encoding="utf-8")]

    actions = []
    for c in cards:
        text = f"{c['category']} {c['card_type']} {c['summary']}"
        vec = await encode(text)
        actions.append({
            "_index":  INDEX_NAME,
            "_id":     c["card_id"],
            "_source": {**c, "content_vector": vec},
        })

    helpers.bulk(client, actions)
    client.indices.refresh(INDEX_NAME)


if __name__ == "__main__":
    import asyncio
    asyncio.run(build())
