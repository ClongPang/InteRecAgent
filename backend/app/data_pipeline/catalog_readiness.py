from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.data_pipeline.catalog_builder import CatalogBuildConfig
from backend.app.services.product_store import load_catalog_artifact


@dataclass
class CatalogReadinessReport:
    ready: bool
    catalog_path: str
    demo_pool_path: str
    quality_report_path: str
    product_count: int = 0
    demo_pool_count: int = 0
    scale_status: str = "missing"
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    quality_report: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "catalog_path": self.catalog_path,
            "demo_pool_path": self.demo_pool_path,
            "quality_report_path": self.quality_report_path,
            "product_count": self.product_count,
            "demo_pool_count": self.demo_pool_count,
            "scale_status": self.scale_status,
            "errors": self.errors,
            "warnings": self.warnings,
            "quality_report": self.quality_report,
        }


def check_catalog_readiness(
    artifact_dir: Path | str = Path("data/catalog"),
    config: CatalogBuildConfig | None = None,
) -> CatalogReadinessReport:
    config = config or CatalogBuildConfig()
    artifact_dir = Path(artifact_dir)
    catalog_path = artifact_dir / "normalized_catalog.jsonl"
    demo_pool_path = artifact_dir / "curated_demo_pool.jsonl"
    quality_report_path = artifact_dir / "quality_report.json"
    report = CatalogReadinessReport(
        ready=False,
        catalog_path=str(catalog_path),
        demo_pool_path=str(demo_pool_path),
        quality_report_path=str(quality_report_path),
    )

    products = _load_products(catalog_path, "normalized catalog", report)
    demo_pool = _load_products(demo_pool_path, "curated demo pool", report)
    quality = _load_quality_report(quality_report_path, report)
    report.product_count = len(products)
    report.demo_pool_count = len(demo_pool)
    report.quality_report = quality

    _validate_counts(report, config)
    _validate_quality_report(report, config)
    _validate_demo_pool(report, config)
    report.ready = not report.errors
    return report


def _load_products(path: Path, label: str, report: CatalogReadinessReport):
    if not path.exists():
        report.errors.append(f"{label} is missing: {path}")
        return []
    try:
        products = load_catalog_artifact(path)
    except ValueError as exc:
        report.errors.append(str(exc))
        return []
    if not products:
        report.errors.append(f"{label} is empty: {path}")
    return products


def _load_quality_report(path: Path, report: CatalogReadinessReport) -> dict[str, Any]:
    if not path.exists():
        report.errors.append(f"quality report is missing: {path}")
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report.errors.append(f"quality report is invalid JSON: {path}:{exc.lineno}")
        return {}


def _validate_counts(report: CatalogReadinessReport, config: CatalogBuildConfig) -> None:
    if report.product_count < config.target_min_products:
        report.errors.append(
            f"catalog has {report.product_count} products; target minimum is {config.target_min_products}"
        )
    if report.product_count > config.target_max_products:
        report.errors.append(
            f"catalog has {report.product_count} products; target maximum is {config.target_max_products}"
        )


def _validate_quality_report(report: CatalogReadinessReport, config: CatalogBuildConfig) -> None:
    quality = report.quality_report
    report.scale_status = str(quality.get("scale_status") or "missing")
    if not quality:
        return
    if quality.get("product_count") != report.product_count:
        report.errors.append("quality report product_count does not match normalized catalog")
    if quality.get("scale_status") != "target_met":
        report.errors.append("quality report scale_status must be target_met")
    if quality.get("source_product_count", report.product_count) < config.target_min_products:
        report.warnings.append("source catalog count is below the MVP target minimum")
    for key in ["price_coverage", "image_coverage", "brand_coverage", "category_coverage", "evidence_coverage"]:
        value = quality.get(key)
        if not isinstance(value, (float, int)) or value < 0 or value > 1:
            report.errors.append(f"quality report {key} must be a number between 0 and 1")


def _validate_demo_pool(report: CatalogReadinessReport, config: CatalogBuildConfig) -> None:
    expected_demo_count = min(config.demo_pool_limit, report.product_count)
    if report.demo_pool_count != expected_demo_count:
        report.errors.append(
            f"demo pool has {report.demo_pool_count} products; expected {expected_demo_count}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate InteRecAgent catalog readiness artifacts.")
    parser.add_argument("--artifact-dir", type=Path, default=Path("data/catalog"))
    parser.add_argument("--target-min", type=int, default=20_000)
    parser.add_argument("--target-max", type=int, default=50_000)
    parser.add_argument("--demo-limit", type=int, default=50)
    args = parser.parse_args()
    report = check_catalog_readiness(
        args.artifact_dir,
        CatalogBuildConfig(
            target_min_products=args.target_min,
            target_max_products=args.target_max,
            demo_pool_limit=args.demo_limit,
        ),
    )
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    if not report.ready:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
