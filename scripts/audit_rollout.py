"""Read-only health report for the single released recommendation path."""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text

from backend.application.services.rec.semantic import PROFILE_VERSION
from backend.application.services.rollout import RolloutSample, audit_release_health
from backend.bootstrap.settings import Settings
from backend.infrastructure.persistence.database import create_engine


class ManualAuditSignoff(BaseModel):
    approved: bool
    reviewer: str = Field(min_length=1)
    reviewed_at: datetime
    notes: str = ""

    @field_validator("reviewed_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("reviewed_at must include a timezone")
        return value


async def _load_samples(database_url: str, *, since: datetime) -> list[RolloutSample]:
    engine = create_engine(database_url)
    query = text(
        """
        SELECT rollout.payload_json AS rollout_payload,
               rollout.created_at AS observed_at,
               accepted.created_at AS accepted_at,
               COALESCE(cs.candidates_json, '{}'::jsonb) AS candidate_payload,
               COALESCE(rr.final_json, '{}'::jsonb) AS final_payload,
               COALESCE(
                 jsonb_agg(
                   jsonb_build_object('event_type', message.event_type)
                     || message.payload_json
                   ORDER BY message.sequence
                 )
                   FILTER (WHERE message.id IS NOT NULL),
                 '[]'::jsonb
               ) AS agent_events
        FROM mission_events AS rollout
        LEFT JOIN candidate_sets AS cs
          ON cs.id::text = rollout.payload_json->>'candidate_set_id'
        LEFT JOIN recommendation_runs AS rr
          ON rr.id::text = rollout.payload_json->>'run_id'
        LEFT JOIN mission_events AS accepted
          ON accepted.mission_id = rollout.mission_id
         AND accepted.event_type = 'run.accepted'
         AND accepted.payload_json->>'run_id' = rollout.payload_json->>'run_id'
        LEFT JOIN mission_events AS message
          ON message.mission_id = rollout.mission_id
         AND message.event_type IN ('agent.message', 'recommendation.ready', 'run.degraded')
         AND message.payload_json->>'run_id' = rollout.payload_json->>'run_id'
        WHERE rollout.event_type = 'run.release_observed'
          AND rollout.created_at >= :since
        GROUP BY rollout.id, cs.id, rr.id, accepted.id
        ORDER BY rollout.created_at
        """
    )
    try:
        async with engine.connect() as connection:
            rows = (await connection.execute(query, {"since": since})).mappings().all()
    finally:
        await engine.dispose()
    samples: list[RolloutSample] = []
    for row in rows:
        rollout = dict(row["rollout_payload"] or {})
        flags = dict(rollout.get("feature_flags") or {})
        candidate_payload = dict(row["candidate_payload"] or {})
        profile_versions = {
            str((item.get("profile") or {}).get("classifier_version") or "")
            for item in candidate_payload.get("qualifications") or []
            if isinstance(item, dict)
        }
        inferred_profile_version = (
            next(iter(profile_versions)) if len(profile_versions) == 1 else ""
        )
        recorded_latency = rollout.get("run_latency_ms")
        run_latency_ms = (
            int(recorded_latency)
            if isinstance(recorded_latency, (int, float)) and recorded_latency >= 0
            else (
                max(
                    0,
                    round(
                        (row["observed_at"] - row["accepted_at"]).total_seconds()
                        * 1000
                    ),
                )
                if row["accepted_at"] is not None
                else None
            )
        )
        samples.append(
            RolloutSample(
                run_id=str(rollout.get("run_id") or ""),
                observed_at=row["observed_at"],
                status=str(rollout.get("status") or "unknown"),
                execution_path=str(flags.get("execution_path") or "unlabeled"),
                release_state=str(flags.get("release_state") or "historical"),
                qualification_profile_version=str(
                    flags.get("qualification_profile_version")
                    or inferred_profile_version
                ),
                enabled_item_types=[
                    str(item)
                    for item in (flags.get("enabled_item_types") or [])
                    if str(item)
                ],
                run_latency_ms=run_latency_ms,
                candidate_payload=candidate_payload,
                final_payload=dict(row["final_payload"] or {}),
                agent_events=list(row["agent_events"] or []),
            )
        )
    return samples


def _load_signoff(path: Path | None) -> ManualAuditSignoff | None:
    if path is None:
        return None
    return ManualAuditSignoff.model_validate_json(path.read_text(encoding="utf-8"))


async def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-days", type=int, default=30)
    parser.add_argument("--minimum-samples", type=int, default=300)
    parser.add_argument("--minimum-latency-samples", type=int, default=30)
    parser.add_argument("--max-p95-run-latency-ms", type=int, default=60_000)
    parser.add_argument(
        "--required-item-type",
        action="append",
        dest="required_item_types",
        help="Required category in release evidence; repeat for multiple categories",
    )
    parser.add_argument("--manual-audit-signoff", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-healthy", action="store_true")
    args = parser.parse_args()
    now = datetime.now(UTC)
    signoff = _load_signoff(args.manual_audit_signoff)
    samples = await _load_samples(
        Settings().database_url,
        since=now - timedelta(days=max(1, args.lookback_days)),
    )
    current_samples = [
        item
        for item in samples
        if item.qualification_profile_version == PROFILE_VERSION
        and item.execution_path == "explicit_v2"
        and item.release_state == "full"
        and item.status in {"completed", "degraded", "failed"}
    ]
    signoff_covers_window = bool(
        signoff
        and signoff.approved
        and current_samples
        and signoff.reviewed_at >= max(item.observed_at for item in current_samples)
    )
    report = audit_release_health(
        samples,
        now=now,
        minimum_samples=max(1, args.minimum_samples),
        minimum_latency_samples=max(1, args.minimum_latency_samples),
        max_p95_run_latency_ms=max(1, args.max_p95_run_latency_ms),
        required_item_types=tuple(
            args.required_item_types or ["smartphone", "headphones"]
        ),
        required_qualification_profile_version=PROFILE_VERSION,
        required_enabled_item_types=tuple(Settings().v2_enabled_item_types),
        manual_audit_approved=signoff_covers_window,
    )
    payload = report.model_dump(mode="json")
    payload["manual_audit"] = signoff.model_dump(mode="json") if signoff else None
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output is not None:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 2 if args.require_healthy and not report.release_healthy else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
