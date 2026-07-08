from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.data_pipeline.metadata_loader import iter_jsonl
from backend.app.services.product_store import load_catalog_artifact


@dataclass(frozen=True)
class ProfileBuildConfig:
    min_reviews_per_user: int = 2
    max_profiles: int = 10_000
    max_items_per_profile: int = 10

    def __post_init__(self) -> None:
        if self.min_reviews_per_user < 1:
            raise ValueError("min_reviews_per_user must be positive")
        if self.max_profiles < 1:
            raise ValueError("max_profiles must be positive")
        if self.max_items_per_profile < 1:
            raise ValueError("max_items_per_profile must be positive")


@dataclass(frozen=True)
class ProfileBuildResult:
    profiles: list[dict[str, Any]]
    summary: dict[str, Any]


def build_user_profiles(
    reviews_path: Path,
    catalog_path: Path | None = None,
    config: ProfileBuildConfig | None = None,
) -> ProfileBuildResult:
    config = config or ProfileBuildConfig()
    category_by_product = _load_category_lookup(catalog_path) if catalog_path else {}
    behavior_by_user: dict[str, list[dict[str, Any]]] = defaultdict(list)
    review_count = 0

    for row in iter_jsonl(reviews_path):
        user_id = _user_id(row)
        product_id = _product_id(row)
        if not user_id or not product_id:
            continue
        behavior_by_user[user_id].append(
            {
                "product_id": product_id,
                "rating": _rating(row),
                "timestamp": _timestamp(row),
                "category": category_by_product.get(product_id),
            }
        )
        review_count += 1

    profiles = [
        _build_profile(user_id, behaviors, config)
        for user_id, behaviors in sorted(behavior_by_user.items())
        if len(behaviors) >= config.min_reviews_per_user
    ][: config.max_profiles]

    summary = {
        "profile_count": len(profiles),
        "source_review_count": review_count,
        "source_user_count": len(behavior_by_user),
        "min_reviews_per_user": config.min_reviews_per_user,
        "max_profiles": config.max_profiles,
        "category_join_coverage": _category_join_coverage(profiles),
    }
    return ProfileBuildResult(profiles=profiles, summary=summary)


def write_profile_artifacts(result: ProfileBuildResult, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "user_profiles.jsonl").open("w", encoding="utf-8") as handle:
        for profile in result.profiles:
            handle.write(json.dumps(profile, sort_keys=True))
            handle.write("\n")
    (output_dir / "profile_summary.json").write_text(
        json.dumps(result.summary, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _build_profile(
    user_id: str,
    behaviors: list[dict[str, Any]],
    config: ProfileBuildConfig,
) -> dict[str, Any]:
    sorted_behaviors = sorted(behaviors, key=lambda item: item.get("timestamp") or 0, reverse=True)
    ratings = [behavior["rating"] for behavior in behaviors if behavior["rating"] is not None]
    category_counts = Counter(
        behavior["category"] for behavior in behaviors if isinstance(behavior.get("category"), str)
    )
    positives = [
        behavior["product_id"]
        for behavior in sorted_behaviors
        if behavior["rating"] is not None and behavior["rating"] >= 4
    ]
    negatives = [
        behavior["product_id"]
        for behavior in sorted_behaviors
        if behavior["rating"] is not None and behavior["rating"] <= 2
    ]
    return {
        "user_id": user_id,
        "review_count": len(behaviors),
        "average_rating": round(sum(ratings) / len(ratings), 3) if ratings else None,
        "preferred_categories": [
            {"category": category, "count": count}
            for category, count in category_counts.most_common(config.max_items_per_profile)
        ],
        "positive_product_ids": list(dict.fromkeys(positives))[: config.max_items_per_profile],
        "negative_product_ids": list(dict.fromkeys(negatives))[: config.max_items_per_profile],
        "recent_product_ids": list(
            dict.fromkeys(behavior["product_id"] for behavior in sorted_behaviors)
        )[: config.max_items_per_profile],
    }


def _load_category_lookup(catalog_path: Path) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for product in load_catalog_artifact(catalog_path):
        category = product.leaf_category or (product.category_path[-1] if product.category_path else None)
        if category:
            lookup[product.product_id] = category
    return lookup


def _user_id(row: dict[str, Any]) -> str:
    return str(row.get("reviewerID") or row.get("reviewer_id") or row.get("user_id") or "").strip()


def _product_id(row: dict[str, Any]) -> str:
    return str(row.get("asin") or row.get("product_id") or "").strip()


def _rating(row: dict[str, Any]) -> float | None:
    value = row.get("overall", row.get("rating"))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _timestamp(row: dict[str, Any]) -> int:
    value = row.get("unixReviewTime") or row.get("timestamp") or 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return 0


def _category_join_coverage(profiles: list[dict[str, Any]]) -> float:
    if not profiles:
        return 0.0
    joined = sum(1 for profile in profiles if profile["preferred_categories"])
    return joined / len(profiles)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build internal user profile artifacts from review behavior.")
    parser.add_argument("--reviews", required=True, type=Path, help="Amazon reviews JSONL path")
    parser.add_argument("--catalog", type=Path, help="Optional normalized catalog JSONL path for category joins")
    parser.add_argument("--output", required=True, type=Path, help="Output directory")
    parser.add_argument("--min-reviews-per-user", type=int, default=2)
    parser.add_argument("--max-profiles", type=int, default=10_000)
    args = parser.parse_args()

    result = build_user_profiles(
        args.reviews,
        args.catalog,
        ProfileBuildConfig(
            min_reviews_per_user=args.min_reviews_per_user,
            max_profiles=args.max_profiles,
        ),
    )
    write_profile_artifacts(result, args.output)
    print(json.dumps(result.summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
