from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.services.product_store import load_catalog_artifact
from backend.app.services.vector_index import product_index_row


@dataclass(frozen=True)
class VectorIndexBuildResult:
    rows: list[dict[str, object]]
    manifest: dict[str, Any]


def build_vector_index(catalog_path: Path) -> VectorIndexBuildResult:
    products = load_catalog_artifact(catalog_path)
    rows = [product_index_row(product) for product in products]
    token_count = sum(len(row["tokens"]) for row in rows if isinstance(row.get("tokens"), list))
    manifest = {
        "index_type": "deterministic_token_jaccard",
        "product_count": len(rows),
        "token_count": token_count,
        "catalog_path": str(catalog_path),
    }
    return VectorIndexBuildResult(rows=rows, manifest=manifest)


def write_vector_index_artifacts(result: VectorIndexBuildResult, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "product_index.jsonl").open("w", encoding="utf-8") as handle:
        for row in result.rows:
            handle.write(json.dumps(row, sort_keys=True))
            handle.write("\n")
    (output_dir / "index_manifest.json").write_text(
        json.dumps(result.manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build deterministic product vector index artifacts.")
    parser.add_argument("--catalog", required=True, type=Path, help="Normalized catalog JSONL path")
    parser.add_argument("--output", required=True, type=Path, help="Output directory")
    args = parser.parse_args()

    result = build_vector_index(args.catalog)
    write_vector_index_artifacts(result, args.output)
    print(json.dumps(result.manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
