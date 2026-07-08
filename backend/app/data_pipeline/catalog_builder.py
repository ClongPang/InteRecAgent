from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.data_pipeline.demo_pool import select_demo_pool
from backend.app.data_pipeline.metadata_loader import iter_jsonl, normalize_metadata_row
from backend.app.data_pipeline.quality_report import build_quality_report
from backend.app.data_pipeline.review_loader import attach_review_evidence, load_filtered_review_evidence
from backend.app.schemas import ProductRecommendation


@dataclass(frozen=True)
class CatalogBuildConfig:
    target_min_products: int = 20_000
    target_max_products: int = 50_000
    demo_pool_limit: int = 50
    max_review_snippets_per_product: int = 2

    def __post_init__(self) -> None:
        if self.target_min_products < 1:
            raise ValueError("target_min_products must be positive")
        if self.target_max_products < self.target_min_products:
            raise ValueError("target_max_products must be >= target_min_products")
        if self.demo_pool_limit < 1:
            raise ValueError("demo_pool_limit must be positive")


@dataclass
class CatalogBuildResult:
    products: list[ProductRecommendation]
    demo_pool: list[ProductRecommendation]
    quality_report: dict[str, float | int | str | list[str]]
    source_product_count: int
    filtered_product_count: int
    scale_status: str
    warnings: list[str] = field(default_factory=list)


def _scale_status(product_count: int, config: CatalogBuildConfig) -> str:
    if product_count < config.target_min_products:
        return "below_target"
    if product_count > config.target_max_products:
        return "above_target"
    return "target_met"


def build_catalog(
    metadata_path: Path,
    review_path: Path | None = None,
    config: CatalogBuildConfig | None = None,
) -> CatalogBuildResult:
    config = config or CatalogBuildConfig()
    products, source_product_count, filtered_product_count, eligible_product_count = _load_capped_metadata(
        metadata_path,
        limit=config.target_max_products,
    )
    warnings: list[str] = []

    if filtered_product_count:
        warnings.append(
            f"filtered {filtered_product_count} metadata rows missing title or category"
        )

    if eligible_product_count > config.target_max_products:
        warnings.append(
            f"eligible catalog capped from {eligible_product_count} to {config.target_max_products} products"
        )

    if review_path is not None:
        product_ids = {product.product_id for product in products}
        evidence = load_filtered_review_evidence(
            review_path,
            product_ids,
            max_snippets_per_product=config.max_review_snippets_per_product,
        )
        products = attach_review_evidence(products, evidence)

    scale_status = _scale_status(len(products), config)
    if scale_status == "below_target":
        warnings.append(
            f"catalog has {len(products)} products; target minimum is {config.target_min_products}"
        )

    report = build_quality_report(products)
    report.update(
        {
            "source_product_count": source_product_count,
            "filtered_product_count": filtered_product_count,
            "scale_status": scale_status,
            "warnings": warnings,
        }
    )

    return CatalogBuildResult(
        products=products,
        demo_pool=select_demo_pool(products, limit=config.demo_pool_limit),
        quality_report=report,
        source_product_count=source_product_count,
        filtered_product_count=filtered_product_count,
        scale_status=scale_status,
        warnings=warnings,
    )


def _load_capped_metadata(path: Path, limit: int) -> tuple[list[ProductRecommendation], int, int, int]:
    products: list[ProductRecommendation] = []
    source_product_count = 0
    filtered_product_count = 0
    eligible_product_count = 0
    for row in iter_jsonl(path):
        source_product_count += 1
        if not _has_title_and_category(row):
            filtered_product_count += 1
            continue
        product = normalize_metadata_row(row)
        eligible_product_count += 1
        if len(products) < limit:
            products.append(product)
    return products, source_product_count, filtered_product_count, eligible_product_count


def _has_title_and_category(row: dict) -> bool:
    title = row.get("title")
    category = row.get("category_path") or row.get("categories") or row.get("category")
    return bool(isinstance(title, str) and title.strip() and category)


def write_catalog_artifacts(result: CatalogBuildResult, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_products(output_dir / "normalized_catalog.jsonl", result.products)
    _write_products(output_dir / "curated_demo_pool.jsonl", result.demo_pool)
    (output_dir / "quality_report.json").write_text(
        json.dumps(result.quality_report, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _write_products(path: Path, products: list[ProductRecommendation]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for product in products:
            handle.write(product.model_dump_json())
            handle.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build normalized InteRecAgent catalog artifacts.")
    parser.add_argument("--metadata", required=True, type=Path, help="Amazon metadata JSONL path")
    parser.add_argument("--reviews", type=Path, help="Amazon reviews JSONL path")
    parser.add_argument("--output", required=True, type=Path, help="Output directory")
    parser.add_argument("--target-min", type=int, default=20_000)
    parser.add_argument("--target-max", type=int, default=50_000)
    parser.add_argument("--demo-limit", type=int, default=50)
    args = parser.parse_args()

    result = build_catalog(
        args.metadata,
        args.reviews,
        CatalogBuildConfig(
            target_min_products=args.target_min,
            target_max_products=args.target_max,
            demo_pool_limit=args.demo_limit,
        ),
    )
    write_catalog_artifacts(result, args.output)
    print(json.dumps(result.quality_report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
