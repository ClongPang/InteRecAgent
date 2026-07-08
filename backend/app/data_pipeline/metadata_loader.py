from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any, Iterable, TextIO

from backend.app.schemas import EvidenceItem, ProductRecommendation


def open_jsonl_text(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def iter_jsonl(path: Path) -> Iterable[dict]:
    with open_jsonl_text(path) as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                yield json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_number}") from exc


def normalize_metadata_row(row: dict) -> ProductRecommendation:
    product_id = str(row.get("asin") or row.get("product_id") or "").strip()
    if not product_id:
        raise ValueError("metadata row is missing asin/product_id")

    category_path = _category_path(row)
    metadata_evidence = _metadata_evidence(product_id, row)

    price = _parse_price(row.get("price"))
    matched_tags = _matched_tags(row)

    return ProductRecommendation(
        product_id=product_id,
        title=str(row.get("title") or "Unknown product"),
        brand=row.get("brand"),
        price=price,
        currency=str(row.get("currency") or "USD"),
        image_url=_first_string(
            row.get("image_url"),
            row.get("image"),
            row.get("imageURLHighRes"),
            row.get("imageURL"),
        ),
        category_path=[str(item) for item in category_path],
        leaf_category=str(category_path[-1]) if category_path else None,
        average_rating=row.get("average_rating"),
        review_count=int(row.get("review_count") or 0),
        matched_tags=matched_tags,
        evidence=metadata_evidence,
        uncertainties=[] if price is not None else ["price unknown"],
        rank=0,
    )


def _category_path(row: dict) -> list[Any]:
    category_path = row.get("category_path") or row.get("categories") or row.get("category") or []
    if category_path and isinstance(category_path[0], list):
        category_path = category_path[0]
    return list(category_path)


def _parse_price(value: Any) -> float | None:
    if isinstance(value, (float, int)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").strip()
        try:
            return float(cleaned) if cleaned else None
        except ValueError:
            return None
    return None


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    return item
    return None


def _list_strings(value: Any, limit: int = 5) -> list[str]:
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()][:limit]
    return []


def _matched_tags(row: dict) -> list[str]:
    tags = [str(item) for item in row.get("matched_tags", [])]
    for source in (_list_strings(row.get("feature")), _list_strings(row.get("description"))):
        tags.extend(source[:2])
    return list(dict.fromkeys(tags))[:8]


def _metadata_evidence(product_id: str, row: dict) -> list[EvidenceItem]:
    snippets = [*_list_strings(row.get("feature"), limit=2), *_list_strings(row.get("description"), limit=1)]
    return [
        EvidenceItem(source="metadata", product_id=product_id, text=snippet[:240])
        for snippet in snippets[:3]
    ]


def load_metadata(path: Path) -> list[ProductRecommendation]:
    return [normalize_metadata_row(row) for row in iter_jsonl(path)]
