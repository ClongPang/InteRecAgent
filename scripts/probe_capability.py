"""阶段 0 能力探测：少量真实 BuyWhere + LLM 请求，只记录字段形态，不改产品语义。

用法：uv run python scripts/probe_capability.py
输出：stdout 摘要；脱敏 JSON 写到 artifacts/capability-probe.json
"""
from __future__ import annotations

import asyncio
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from backend.bootstrap.settings import Settings
from backend.infrastructure.llm.openai_compat import OpenAICompatModelBackend

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "capability-probe.json"
API_BASE = "https://api.buywhere.ai"
DOC_ASSUMED_MISSING = (
    "rating",
    "review_count",
    "brand",
    "availability",
    "structured_specs",
    "comparison_attributes",
    "original_price",
    "discount_pct",
    "domain",
)


def _host(url: Any) -> str | None:
    if not isinstance(url, str) or not url:
        return None
    return urlparse(url).netloc or None


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _walk_keys(obj: Any, prefix: str = "") -> list[tuple[str, str]]:
    if isinstance(obj, dict):
        rows: list[tuple[str, str]] = []
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            rows.append((path, _type_name(value)))
            if isinstance(value, dict):
                rows.extend(_walk_keys(value, path))
            elif isinstance(value, list) and value and isinstance(value[0], dict):
                rows.extend(_walk_keys(value[0], f"{path}[]"))
        return rows
    return []


def _field_stats(items: list[dict]) -> dict[str, Any]:
    present: Counter[str] = Counter()
    nonempty: Counter[str] = Counter()
    types: dict[str, Counter[str]] = {}
    for item in items:
        for path, typ in _walk_keys(item):
            present[path] += 1
            raw = item
            for part in path.replace("[]", "").split("."):
                if not isinstance(raw, dict):
                    raw = None
                    break
                raw = raw.get(part)
            if raw not in (None, "", [], {}):
                nonempty[path] += 1
            types.setdefault(path, Counter())[typ] += 1
    n = max(len(items), 1)
    return {
        path: {
            "present": present[path],
            "nonempty": nonempty[path],
            "coverage": round(nonempty[path] / n, 3),
            "types": dict(types[path]),
        }
        for path in sorted(present)
    }


def _redact_product(item: dict) -> dict[str, Any]:
    price = item.get("price") if isinstance(item.get("price"), dict) else {}
    return {
        "id": item.get("id"),
        "title_len": len(str(item.get("title") or "")),
        "title_tokens": str(item.get("title") or "")[:80],
        "merchant": item.get("merchant"),
        "country_code": item.get("country_code"),
        "region": item.get("region"),
        "price_amount": price.get("amount"),
        "price_currency": price.get("currency"),
        "url_host": _host(item.get("url")),
        "click_host": _host(item.get("click_url")),
        "has_image": bool(item.get("image_url")),
        "updated_at": item.get("updated_at"),
        "metadata_type": _type_name(item.get("metadata")),
        "metadata_keys": sorted((item.get("metadata") or {}).keys())
        if isinstance(item.get("metadata"), dict)
        else None,
        "extra_keys": sorted(set(item) - {
            "id",
            "title",
            "price",
            "merchant",
            "url",
            "image_url",
            "region",
            "country_code",
            "updated_at",
            "click_url",
            "affiliate_redirect_url",
            "has_affiliate_tracking",
            "is_affiliate",
            "affiliate_disclosure",
            "metadata",
        }),
    }


async def _get(client: httpx.AsyncClient, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    resp = await client.get(path, params=params)
    body: Any
    try:
        body = resp.json()
    except ValueError:
        body = {"_raw": resp.text[:400]}
    return {"status": resp.status_code, "body": body}


async def probe_buywhere(settings: Settings) -> dict[str, Any]:
    headers = {"x-api-key": settings.buywhere_api_key, "Accept": "application/json"}
    calls: list[dict[str, Any]] = []
    products: list[dict] = []
    async with httpx.AsyncClient(base_url=API_BASE, headers=headers, timeout=20.0) as client:
        searches = [
            ("sony wh1000xm5 headphones", "US", "keyword", 8),
            ("sony wh1000xm5 headphones", "SG", "keyword", 8),
        ]
        for query, market, mode, limit in searches:
            result = await _get(
                client,
                "/v1/products/search",
                {"q": query, "country_code": market, "mode": mode, "limit": limit},
            )
            data = result["body"].get("data") if isinstance(result["body"], dict) else None
            items = data if isinstance(data, list) else []
            products.extend(item for item in items if isinstance(item, dict))
            calls.append(
                {
                    "op": "search",
                    "query": query,
                    "market": market,
                    "mode": mode,
                    "status": result["status"],
                    "count": len(items),
                    "meta_keys": sorted((result["body"].get("meta") or {}).keys())
                    if isinstance(result["body"], dict)
                    else [],
                    "samples": [_redact_product(item) for item in items[:3]],
                }
            )

        priced = [item for item in products if isinstance(item.get("price"), dict) and item["price"].get("amount")]
        ids = []
        for item in priced:
            pid = str(item.get("id") or "")
            if pid and pid not in ids:
                ids.append(pid)
            if len(ids) >= 2:
                break

        detail_items: list[dict] = []
        for pid in ids[:2]:
            result = await _get(client, f"/v1/products/{pid}")
            data = result["body"].get("data") if isinstance(result["body"], dict) else None
            items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
            detail_items.extend(item for item in items if isinstance(item, dict))
            calls.append(
                {
                    "op": "detail",
                    "id": pid,
                    "status": result["status"],
                    "container": "data[]" if isinstance(data, list) else type(data).__name__,
                    "count": len(items),
                    "samples": [_redact_product(item) for item in items[:1]],
                    "top_keys": sorted(items[0].keys()) if items and isinstance(items[0], dict) else [],
                }
            )

        if len(ids) >= 2:
            result = await _get(client, "/v1/products/compare", {"ids": ",".join(ids[:2])})
            data = result["body"].get("data") if isinstance(result["body"], dict) else None
            items = data if isinstance(data, list) else []
            calls.append(
                {
                    "op": "compare",
                    "ids": ids[:2],
                    "status": result["status"],
                    "count": len(items),
                    "samples": [_redact_product(item) for item in items[:2]],
                    "top_keys": sorted(items[0].keys()) if items and isinstance(items[0], dict) else [],
                    "field_stats": _field_stats([item for item in items if isinstance(item, dict)]),
                }
            )

        price_calls = []
        for pid in ids[:2]:
            result = await _get(client, f"/v1/products/{pid}/prices", {"days": 30})
            payload = result["body"].get("data") if isinstance(result["body"], dict) else None
            payload = payload if isinstance(payload, dict) else {}
            history = payload.get("history") if isinstance(payload.get("history"), list) else []
            stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
            price_calls.append(
                {
                    "id": pid,
                    "status": result["status"],
                    "keys": sorted(payload.keys()),
                    "history_len": len(history),
                    "stats_keys": sorted(stats.keys()),
                    "current_price": payload.get("current_price"),
                    "currency": payload.get("currency"),
                }
            )
        calls.append({"op": "prices", "items": price_calls})

    search_items = [item for item in products if isinstance(item, dict)]
    assumed_present = {
        name: any(name in item for item in search_items) for name in DOC_ASSUMED_MISSING
    }
    return {
        "request_count": 2 + len(ids[:2]) + (1 if len(ids) >= 2 else 0) + len(ids[:2]),
        "calls": calls,
        "search_field_stats": _field_stats(search_items),
        "detail_field_stats": _field_stats(detail_items),
        "doc_assumed_fields_present_in_search": assumed_present,
        "detail_adds_keys_over_search": sorted(
            set().union(*(item.keys() for item in detail_items)) - set().union(*(item.keys() for item in search_items))
        )
        if detail_items and search_items
        else [],
    }


async def probe_llm(settings: Settings) -> dict[str, Any]:
    if settings.llm_provider == "unconfigured" or not settings.llm_api_key:
        return {"skipped": True, "reason": "llm unconfigured"}
    backend = OpenAICompatModelBackend(
        settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
    )
    cases = [
        "通勤降噪耳机，预算 2500 元，美国",
        "太贵了",
        "帮我比前两个",
    ]
    results = []
    try:
        for text in cases:
            try:
                patch = await backend.parse_intent(text)
                results.append({"text": text, "ok": True, "patch": patch.model_dump()})
            except Exception as exc:
                results.append({"text": text, "ok": False, "error": type(exc).__name__})
    finally:
        await backend.aclose()
    return {
        "skipped": False,
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "base_url": settings.llm_base_url,
        "cases": results,
    }


async def main() -> None:
    settings = Settings()
    if not settings.buywhere_api_key:
        raise SystemExit("缺少 INTEREC_BUYWHERE_API_KEY，无法探测")
    buywhere = await probe_buywhere(settings)
    llm = await probe_llm(settings)
    report = {
        "probed_at": datetime.now(UTC).isoformat(),
        "buywhere": buywhere,
        "llm": llm,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(
        {
            "artifact": str(OUT),
            "buywhere_requests": buywhere.get("request_count"),
            "search_keys": list(buywhere.get("search_field_stats", {})),
            "detail_adds": buywhere.get("detail_adds_keys_over_search"),
            "assumed_present": buywhere.get("doc_assumed_fields_present_in_search"),
            "llm": {
                "skipped": llm.get("skipped"),
                "ok": [item.get("ok") for item in llm.get("cases", [])],
            },
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    asyncio.run(main())
