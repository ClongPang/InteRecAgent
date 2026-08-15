# app/tools/category_insight.py
import asyncio
import os
import re
import time
from functools import lru_cache
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel

from app.api.monitor import monitor
from app.recall.category_kb import CategoryCard
from app.recall.reranker import reranker
from app.recall.towers import tower_client


class Bestseller(BaseModel):
    name: str
    typical_price_cny: float
    why_popular: str


class AttributeDist(BaseModel):
    name: str
    distribution: dict[str, float]  # {"尼龙": 0.6, "帆布": 0.25, ...}


class PriceTier(BaseModel):
    tier: Literal["budget", "mid", "premium"]
    range_cny: tuple[float, float]
    notes: str


class CategoryInsightOutput(BaseModel):
    category: str
    components: list[str]  # 这个品类典型由哪几件组成（适用于"套装"类）
    bestsellers: list[Bestseller]
    attributes: list[AttributeDist]
    price_tiers: list[PriceTier]
    confidence: float  # 整体置信度


INDEX_NAME = "globex_category_kb"
COARSE_K = 30
FINE_K_QUICK = 8
FINE_K_DEEP = 15
RERANK_BYPASS_TOP_SCORE = 0.92
SEMANTIC_TOKENS = {"气质", "感觉", "风格", "感", "适合", "送", "氛围"}


def should_disable_bm25(category: str) -> bool:
    """品类 query 含语义化 token，关掉 BM25 子路。"""
    return any(token in category for token in SEMANTIC_TOKENS)


@lru_cache(maxsize=1)
def _kb_client():
    """Create the OpenSearch client lazily so importing the tool has no env side effects."""
    try:
        from opensearchpy import OpenSearch
    except ImportError as exc:
        raise RuntimeError("opensearch-py is required to use category_insight") from exc

    password = os.environ.get("OPENSEARCH_PASSWORD") or os.environ.get("OPENSEARCH_PASS")
    required = {
        "OPENSEARCH_HOST": os.environ.get("OPENSEARCH_HOST"),
        "OPENSEARCH_USER": os.environ.get("OPENSEARCH_USER"),
        "OPENSEARCH_PASSWORD/OPENSEARCH_PASS": password,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise RuntimeError(f"Missing OpenSearch config: {', '.join(missing)}")

    return OpenSearch(
        hosts=[{
            "host": os.environ["OPENSEARCH_HOST"],
            "port": int(os.environ.get("OPENSEARCH_PORT", "9200")),
        }],
        http_auth=(os.environ["OPENSEARCH_USER"], password),
        use_ssl=os.environ.get("OPENSEARCH_USE_SSL", "false").lower() == "true",
    )


async def _recall_cards(category: str, top_k: int) -> list[CategoryCard]:
    """Hybrid coarse recall plus optional cross-encoder rerank."""
    params: dict[str, str] = {}
    try:
        emb = await tower_client.encode_query(category)
        body = _build_hybrid_body(category, emb, coarse_k=COARSE_K)
        if not should_disable_bm25(category):
            params = {"search_pipeline": "globex_hybrid_pipeline"}
    except Exception as exc:
        await monitor.report_error("category_insight_tower", str(exc))
        body = _build_bm25_body(category, coarse_k=COARSE_K)

    try:
        response = await asyncio.to_thread(
            _kb_client().search,
            index=INDEX_NAME,
            body=body,
            params=params,
        )
    except Exception as exc:
        await monitor.report_error("category_insight_opensearch", str(exc))
        return []

    hits = response.get("hits", {}).get("hits", [])
    if not hits:
        return []

    if hits[0].get("_score", 0.0) >= RERANK_BYPASS_TOP_SCORE:
        return _cards_from_hits(hits[:top_k])

    if len(hits) <= top_k:
        return _cards_from_hits(hits)

    try:
        rerank_items = [
            (hit, hit["_source"]["summary"])
            for hit in hits
            if hit.get("_source") and hit["_source"].get("summary")
        ]
        candidates_text = [summary for _, summary in rerank_items]
        scores = await reranker.score(category, candidates_text)
        if len(scores) != len(candidates_text):
            raise RuntimeError("Reranker score count did not match candidates")
        scored_hits = [(score, hit) for score, (hit, _) in zip(scores, rerank_items)]
        paired = sorted(scored_hits, key=lambda item: item[0], reverse=True)
        return _cards_from_hits([hit for _, hit in paired[:top_k]])
    except Exception as exc:
        await monitor.report_error("category_insight_reranker", str(exc))
        return _cards_from_hits(hits[:top_k])


def _build_hybrid_body(category: str, emb: list[float], coarse_k: int) -> dict[str, Any]:
    knn_query: dict[str, Any] = {
        "knn": {"content_vector": {"vector": emb, "k": coarse_k}}
    }
    if should_disable_bm25(category):
        return {"size": coarse_k, "query": knn_query}

    return {
        "size": coarse_k,
        "query": {
            "hybrid": {
                "queries": [
                    knn_query,
                    _bm25_query(category),
                ]
            }
        },
    }


def _build_bm25_body(category: str, coarse_k: int) -> dict[str, Any]:
    return {"size": coarse_k, "query": _bm25_query(category)}


def _bm25_query(category: str) -> dict[str, Any]:
    return {
        "multi_match": {
            "query": category,
            "fields": ["category^2", "summary"],
            "analyzer": "ik_max_word",
        }
    }


def _cards_from_hits(hits: list[dict[str, Any]]) -> list[CategoryCard]:
    cards: list[CategoryCard] = []
    for hit in hits:
        source = hit.get("_source")
        if source:
            cards.append(CategoryCard.model_validate(source))
    return cards


def _split_by_type(cards: list[CategoryCard]) -> dict[str, list[CategoryCard]]:
    bag: dict[str, list[CategoryCard]] = {
        "bestseller": [],
        "attribute": [],
        "price_range": [],
    }
    for card in cards:
        bag.setdefault(card.card_type, []).append(card)
    return bag


def _extract_components(bestseller_cards: list[CategoryCard]) -> list[str]:
    """Extract typical kit components from summaries like '旅行三件套：洗漱包 / 鞋包'."""
    found: list[str] = []
    seen: set[str] = set()
    for card in bestseller_cards:
        if "：" in card.summary:
            _, parts = card.summary.split("：", 1)
        elif ":" in card.summary:
            _, parts = card.summary.split(":", 1)
        else:
            continue
        if "/" not in parts and "、" not in parts:
            continue
        for token in re.split(r"[/、,，]", parts):
            token = token.strip()
            if token and token not in seen:
                seen.add(token)
                found.append(token)
    return found


def _parse_price(raw: str) -> float | None:
    match = re.search(r"\d+(?:\.\d+)?", raw.replace(",", ""))
    return float(match.group()) if match else None


def _extract_bestsellers(cards: list[CategoryCard]) -> list[Bestseller]:
    out: list[Bestseller] = []
    for card in cards:
        for line in card.raw_evidence:
            parts = [part.strip() for part in line.split("|")]
            if len(parts) < 3:
                continue
            price = _parse_price(parts[1])
            if price is None:
                continue
            out.append(Bestseller(
                name=parts[0],
                typical_price_cny=price,
                why_popular=parts[2],
            ))
            if len(out) >= 5:
                return out
    return out


def _extract_price_tiers(cards: list[CategoryCard]) -> list[PriceTier]:
    out: list[PriceTier] = []
    tier_aliases: dict[str, Literal["budget", "mid", "premium"]] = {
        "budget": "budget",
        "cheap": "budget",
        "便宜": "budget",
        "低价": "budget",
        "入门": "budget",
        "mid": "mid",
        "middle": "mid",
        "中档": "mid",
        "中端": "mid",
        "premium": "premium",
        "高端": "premium",
        "高价": "premium",
    }

    def normalize_tier(raw: str) -> Literal["budget", "mid", "premium"] | None:
        lowered = raw.strip().lower()
        for key, value in tier_aliases.items():
            if key in lowered:
                return value
        return None

    def add_tier(tier: Literal["budget", "mid", "premium"], low: float, high: float, notes: str) -> None:
        if not any(existing.tier == tier for existing in out):
            out.append(PriceTier(tier=tier, range_cny=(low, high), notes=notes))

    for card in cards:
        for line in [card.summary, *card.raw_evidence]:
            parts = [part.strip() for part in line.split("|")]
            if len(parts) >= 4:
                tier = normalize_tier(parts[0])
                low = _parse_price(parts[1])
                high = _parse_price(parts[2])
                if tier and low is not None and high is not None:
                    add_tier(tier, low, high, parts[3])
                    continue

            for chunk in re.split(r"[/；;]", line):
                tier = normalize_tier(chunk)
                if tier is None:
                    continue
                numbers = [float(item) for item in re.findall(r"\d+(?:\.\d+)?", chunk)]
                if len(numbers) >= 2:
                    low, high = numbers[0], numbers[1]
                elif len(numbers) == 1 and "+" in chunk:
                    low, high = numbers[0], numbers[0] * 2.5
                else:
                    continue
                add_tier(tier, low, high, chunk.strip())
    return out


def _extract_attributes(cards: list[CategoryCard]) -> list[AttributeDist]:
    merged: dict[str, dict[str, float]] = {}
    for card in cards:
        for line in [card.summary, *card.raw_evidence]:
            for segment in re.split(r"[；;]", line):
                if "：" in segment:
                    name, rest = segment.split("：", 1)
                elif ":" in segment:
                    name, rest = segment.split(":", 1)
                elif "|" in segment:
                    name, rest = segment.split("|", 1)
                else:
                    continue

                name = name.strip()
                if not name or "占" in name:
                    continue

                dist = merged.setdefault(name, {})
                for chunk in re.split(r"[/、,，]", rest):
                    match = re.search(r"(.+?)\s*(\d+(?:\.\d+)?)\s*%?$", chunk.strip())
                    if not match:
                        continue
                    label = match.group(1).strip()
                    if not label or label in {"占", "约", "和", "及"}:
                        continue
                    numeric = float(match.group(2))
                    dist[label] = numeric / 100 if numeric > 1 else numeric

    return [
        AttributeDist(name=name, distribution=distribution)
        for name, distribution in merged.items()
        if distribution
    ]


@tool
async def category_insight(
    category: str,
    depth: Literal["quick", "deep"] = "quick",
) -> CategoryInsightOutput:
    """获取一个品类的结构化常识：典型组件 / 爆款 / 属性分布 / 价格档位。

    Use when: 品类不确定、组合品类组件不清，或需要 RAG 品类常识辅助
    后续检索。
    Do not use when: 品类已经明确且可以直接检索；这时不要多此一举。
    """
    await monitor.report_tool_start("category_insight", {
        "category": category,
        "depth": depth,
    })
    t0 = time.time()

    try:
        top_k = FINE_K_QUICK if depth == "quick" else FINE_K_DEEP
        cards = await _recall_cards(category, top_k)
        grouped = _split_by_type(cards)

        components = _extract_components(grouped["bestseller"])
        bestsellers = _extract_bestsellers(grouped["bestseller"])
        price_tiers = _extract_price_tiers(grouped["price_range"])
        attributes = _extract_attributes(grouped["attribute"]) if depth == "deep" else []
        confidence = sum(card.confidence for card in cards) / len(cards) if cards else 0.0

        return CategoryInsightOutput(
            category=category,
            components=components,
            bestsellers=bestsellers,
            attributes=attributes,
            price_tiers=price_tiers,
            confidence=confidence,
        )
    except Exception as exc:
        await monitor.report_error("category_insight", str(exc))
        return CategoryInsightOutput(
            category=category,
            components=[],
            bestsellers=[],
            attributes=[],
            price_tiers=[],
            confidence=0.0,
        )
    finally:
        await monitor.report_tool_end(
            "category_insight",
            int((time.time() - t0) * 1000),
        )
