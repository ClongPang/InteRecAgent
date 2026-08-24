"""Read-only semantic-profile shadow promotion report."""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import text

from backend.application.services.semantic_rollout import (
    SemanticShadowRun,
    audit_semantic_shadow,
)
from backend.bootstrap.settings import Settings
from backend.infrastructure.persistence.database import create_engine


async def _load_runs(database_url: str, *, since: datetime) -> list[SemanticShadowRun]:
    engine = create_engine(database_url)
    query = text(
        """
        SELECT run_id::text AS run_id, created_at, candidates_json
        FROM candidate_sets
        WHERE created_at >= :since
          AND candidates_json ? 'semantic_shadow_stats'
        ORDER BY created_at
        """
    )
    try:
        async with engine.connect() as connection:
            rows = (await connection.execute(query, {"since": since})).mappings().all()
    finally:
        await engine.dispose()
    return [
        SemanticShadowRun(
            run_id=str(row["run_id"]),
            observed_at=row["created_at"],
            candidate_payload=dict(row["candidates_json"] or {}),
        )
        for row in rows
    ]


def _load_reviewed_decisions(path: Path | None) -> set[str]:
    if path is None:
        return set()
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(
        payload.get("reviewed_decision_ids"), list
    ):
        raise ValueError("review file must contain reviewed_decision_ids[]")
    return {str(item) for item in payload["reviewed_decision_ids"] if str(item)}


async def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-days", type=int, default=30)
    parser.add_argument("--minimum-samples-per-category", type=int, default=100)
    parser.add_argument(
        "--required-category",
        action="append",
        dest="required_categories",
    )
    parser.add_argument("--reviewed-decisions", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()

    now = datetime.now(UTC)
    runs = await _load_runs(
        Settings().database_url,
        since=now - timedelta(days=max(1, args.lookback_days)),
    )
    report = audit_semantic_shadow(
        runs,
        now=now,
        required_categories=tuple(
            args.required_categories or ("smartphone", "headphones")
        ),
        minimum_samples_per_category=max(1, args.minimum_samples_per_category),
        reviewed_decisions=_load_reviewed_decisions(args.reviewed_decisions),
    )
    rendered = report.model_dump_json(indent=2)
    if args.output is not None:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 2 if args.require_ready and not report.promotion_ready else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
