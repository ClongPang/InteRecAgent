from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.services.vector_index import load_vector_index_artifact


@dataclass
class VectorIndexReadinessReport:
    ready: bool
    index_path: str
    manifest_path: str
    product_count: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    manifest: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "index_path": self.index_path,
            "manifest_path": self.manifest_path,
            "product_count": self.product_count,
            "errors": self.errors,
            "warnings": self.warnings,
            "manifest": self.manifest,
        }


def check_vector_index_readiness(
    artifact_dir: Path | str = Path("data/indexes"),
    min_products: int = 1,
) -> VectorIndexReadinessReport:
    artifact_dir = Path(artifact_dir)
    index_path = artifact_dir / "product_index.jsonl"
    manifest_path = artifact_dir / "index_manifest.json"
    report = VectorIndexReadinessReport(
        ready=False,
        index_path=str(index_path),
        manifest_path=str(manifest_path),
    )

    vectors = _load_index(index_path, report)
    manifest = _load_manifest(manifest_path, report)
    report.product_count = len(vectors)
    report.manifest = manifest

    if report.product_count < min_products:
        report.errors.append(
            f"vector index has {report.product_count} products; minimum is {min_products}"
        )
    if manifest:
        if manifest.get("product_count") != report.product_count:
            report.errors.append("index manifest product_count does not match product_index.jsonl")
        if manifest.get("index_type") != "deterministic_token_jaccard":
            report.errors.append("index manifest index_type is unsupported")
        if manifest.get("token_count", 0) <= 0:
            report.errors.append("index manifest token_count must be positive")

    report.ready = not report.errors
    return report


def _load_index(path: Path, report: VectorIndexReadinessReport) -> dict[str, set[str]]:
    if not path.exists():
        report.errors.append(f"vector index is missing: {path}")
        return {}
    try:
        vectors = load_vector_index_artifact(path)
    except ValueError as exc:
        report.errors.append(str(exc))
        return {}
    if not vectors:
        report.errors.append(f"vector index is empty: {path}")
    return vectors


def _load_manifest(path: Path, report: VectorIndexReadinessReport) -> dict[str, Any]:
    if not path.exists():
        report.errors.append(f"index manifest is missing: {path}")
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report.errors.append(f"index manifest is invalid JSON: {path}:{exc.lineno}")
        return {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate product vector index artifacts.")
    parser.add_argument("--artifact-dir", type=Path, default=Path("data/indexes"))
    parser.add_argument("--min-products", type=int, default=1)
    args = parser.parse_args()

    report = check_vector_index_readiness(args.artifact_dir, args.min_products)
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    if not report.ready:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
