from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from backend.app.schemas import ProductRecommendation


def iter_jsonl(path: Path) -> Iterable[dict]:
    with path.open("r", encoding="utf-8") as handle:
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

    category_path = row.get("category_path") or row.get("categories") or []
    if category_path and isinstance(category_path[0], list):
        category_path = category_path[0]

    price = row.get("price")
    if isinstance(price, str):
        cleaned = price.replace("$", "").replace(",", "").strip()
        price = float(cleaned) if cleaned else None

    return ProductRecommendation(
        product_id=product_id,
        title=str(row.get("title") or "Unknown product"),
        brand=row.get("brand"),
        price=price if isinstance(price, (float, int)) else None,
        currency=str(row.get("currency") or "USD"),
        image_url=row.get("image_url") or row.get("image"),
        category_path=[str(item) for item in category_path],
        leaf_category=str(category_path[-1]) if category_path else None,
        average_rating=row.get("average_rating"),
        review_count=int(row.get("review_count") or 0),
        matched_tags=[str(item) for item in row.get("matched_tags", [])],
        uncertainties=[] if price is not None else ["price unknown"],
        rank=0,
    )


def load_metadata(path: Path) -> list[ProductRecommendation]:
    return [normalize_metadata_row(row) for row in iter_jsonl(path)]
