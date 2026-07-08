from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.data_pipeline.metadata_loader import iter_jsonl


@dataclass
class ProfileReadinessReport:
    ready: bool
    profiles_path: str
    summary_path: str
    profile_count: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "profiles_path": self.profiles_path,
            "summary_path": self.summary_path,
            "profile_count": self.profile_count,
            "errors": self.errors,
            "warnings": self.warnings,
            "summary": self.summary,
        }


def check_profile_readiness(
    artifact_dir: Path | str = Path("data/profiles"),
    min_profiles: int = 1,
) -> ProfileReadinessReport:
    artifact_dir = Path(artifact_dir)
    profiles_path = artifact_dir / "user_profiles.jsonl"
    summary_path = artifact_dir / "profile_summary.json"
    report = ProfileReadinessReport(
        ready=False,
        profiles_path=str(profiles_path),
        summary_path=str(summary_path),
    )

    profiles = _load_profiles(profiles_path, report)
    summary = _load_summary(summary_path, report)
    report.profile_count = len(profiles)
    report.summary = summary

    if report.profile_count < min_profiles:
        report.errors.append(
            f"profile artifact has {report.profile_count} profiles; minimum is {min_profiles}"
        )
    if summary:
        if summary.get("profile_count") != report.profile_count:
            report.errors.append("profile summary profile_count does not match user_profiles.jsonl")
        if summary.get("source_review_count", 0) < report.profile_count:
            report.errors.append("profile summary source_review_count is inconsistent")
        if summary.get("category_join_coverage", 0) == 0:
            report.warnings.append("profile categories are unavailable; ranking can still use product history")

    report.ready = not report.errors
    return report


def _load_profiles(path: Path, report: ProfileReadinessReport) -> list[dict[str, Any]]:
    if not path.exists():
        report.errors.append(f"user profiles are missing: {path}")
        return []
    try:
        profiles = list(iter_jsonl(path))
    except ValueError as exc:
        report.errors.append(str(exc))
        return []
    for index, profile in enumerate(profiles, start=1):
        if not profile.get("user_id"):
            report.errors.append(f"profile at line {index} is missing user_id")
        if not isinstance(profile.get("review_count"), int) or profile["review_count"] < 1:
            report.errors.append(f"profile at line {index} has invalid review_count")
    return profiles


def _load_summary(path: Path, report: ProfileReadinessReport) -> dict[str, Any]:
    if not path.exists():
        report.errors.append(f"profile summary is missing: {path}")
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report.errors.append(f"profile summary is invalid JSON: {path}:{exc.lineno}")
        return {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate internal user profile artifacts.")
    parser.add_argument("--artifact-dir", type=Path, default=Path("data/profiles"))
    parser.add_argument("--min-profiles", type=int, default=1)
    args = parser.parse_args()

    report = check_profile_readiness(args.artifact_dir, args.min_profiles)
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    if not report.ready:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
