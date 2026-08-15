import asyncio
import time
from typing import Any
from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.api.monitor import monitor
from app.recall.ann import ann_client
from app.recall.towers import tower_client


class Candidate(BaseModel):
    """单个候选商品的稳定结构（后续工具按这个 schema 消费）。"""

    item_id: str
    platform: str
    title: str
    price: float
    currency: str
    rating: float | None = None
    sales: int | None = None
    image_url: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class ItemSearchOutput(BaseModel):
    platform: str
    candidates: list[Candidate]
    total_recall: int  # 召回总数（语义 + 个性化）
    truncated: bool  # 是否因为 top_k 截断


DEFAULT_ITEM_SEARCH_TOP_K = 20
MAX_ITEM_SEARCH_TOP_K = 20
MAX_ATTRIBUTE_VALUE_CHARS = 120
LIGHTWEIGHT_ATTRIBUTES = {
    "brand",
    "material",
    "color",
    "size",
    "pack_size",
    "style",
}


@tool
async def item_search(
    query: str,
    platform: Literal["amazon", "shopee", "aliexpress", "ebay"],
    top_k: int = DEFAULT_ITEM_SEARCH_TOP_K,
    user_id: str | None = None,
) -> ItemSearchOutput:
    """在指定单个平台检索商品候选集。

    Use when: 平台已知、品类明确，且一次单平台检索就能推进任务。
    Do not use when: 用户要求跨多个平台比较；跨平台检索应通过
    dispatch_tool 并行派发多个子 Agent，而不是主 loop 串行调用本工具。
    """
    top_k = max(0, min(top_k, MAX_ITEM_SEARCH_TOP_K))
    await monitor.report_tool_start("item_search", {
        "query": query,
        "platform": platform,
        "top_k": top_k,
    })
    t0 = time.time()

    try:
        raw, total_recall = await _recall(query, platform, top_k, user_id)
        candidates = [
            Candidate(
                item_id=r["item_id"],
                platform=platform,
                title=r["title"],
                price=r["price"],
                currency=r["currency"],
                rating=r.get("rating"),
                sales=r.get("sales"),
                image_url=None,
                attributes=_compact_attributes(r.get("attributes", {})),
            )
            for r in raw
        ]

        return ItemSearchOutput(
            platform=platform,
            candidates=candidates,
            total_recall=total_recall,
            truncated=total_recall > len(candidates),
        )
    except Exception as exc:
        await monitor.report_error("item_search", str(exc))
        raise
    finally:
        await monitor.report_tool_end(
            "item_search",
            int((time.time() - t0) * 1000),
        )


async def _recall(
    query: str,
    platform: str,
    top_k: int,
    user_id: str | None,
) -> tuple[list[dict[str, Any]], int]:
    # 语义通道（始终启用）
    semantic_task = asyncio.create_task(_semantic_recall(query, platform, top_k))
    # 个性化通道（可选）
    personalized_task = (
        asyncio.create_task(_personalized_recall(query, platform, top_k, user_id))
        if user_id
        else None
    )

    semantic = await semantic_task
    personalized = await personalized_task if personalized_task else []

    merged = _dedupe_and_rerank(semantic, personalized)
    return merged[:top_k], len(semantic) + len(personalized)


async def _semantic_recall(
    query: str,
    platform: str,
    top_k: int,
) -> list[dict[str, Any]]:
    emb = await tower_client.encode_query(query)
    return ann_client.search(emb, top_k, platform)


async def _personalized_recall(
    query: str,
    platform: str,
    top_k: int,
    user_id: str,
) -> list[dict[str, Any]]:
    user_emb, query_emb = await asyncio.gather(
        tower_client.encode_user(user_id),
        tower_client.encode_query(query),
    )
    fused = [0.6 * u + 0.4 * q for u, q in zip(user_emb, query_emb)]
    return ann_client.search(fused, top_k, platform)


def _dedupe_and_rerank(
    a: list[dict[str, Any]],
    b: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """两路召回去重，并按 score 加权重排。"""
    bag: dict[str, dict[str, Any]] = {}
    for item in a:
        bag[item["item_id"]] = {**item, "boost": item["score"]}
    for item in b:
        existing = bag.get(item["item_id"])
        if existing:
            existing["boost"] += 0.5 * item["score"]  # 双通道命中加分
        else:
            bag[item["item_id"]] = {**item, "boost": item["score"] * 0.8}
    return sorted(bag.values(), key=lambda x: x["boost"], reverse=True)


def _compact_attributes(attributes: dict[str, Any]) -> dict[str, Any]:
    """Keep item attributes small enough to enter prompt context safely."""
    compact: dict[str, Any] = {}
    for key in LIGHTWEIGHT_ATTRIBUTES:
        if key not in attributes:
            continue
        value = attributes[key]
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            text = str(value)
            compact[key] = text[:MAX_ATTRIBUTE_VALUE_CHARS]
    return compact
