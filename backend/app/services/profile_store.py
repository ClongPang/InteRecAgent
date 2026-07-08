from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from backend.app.data_pipeline.metadata_loader import iter_jsonl


DEFAULT_PROFILE_ARTIFACT_PATH = Path("data/profiles/user_profiles.jsonl")


def default_profile_artifact_path() -> Path:
    configured_path = os.getenv("INTEREC_PROFILE_PATH")
    return Path(configured_path) if configured_path else DEFAULT_PROFILE_ARTIFACT_PATH


def load_profile_artifact(path: Path | str) -> dict[str, dict[str, Any]]:
    profile_path = Path(path)
    profiles: dict[str, dict[str, Any]] = {}
    try:
        rows = iter_jsonl(profile_path)
        for row in rows:
            user_id = str(row.get("user_id") or "").strip()
            if not user_id:
                continue
            profiles[user_id] = row
    except ValueError as exc:
        raise ValueError(f"Invalid profile artifact at {exc}") from exc
    return profiles


class ProfileStore:
    def __init__(
        self,
        profiles: dict[str, dict[str, Any]] | None = None,
        profile_path: Path | str | None = None,
        load_default_artifact: bool = True,
    ) -> None:
        if profiles is not None:
            self._profiles = profiles
            self.source = "injected"
            return

        artifact_path = Path(profile_path) if profile_path else default_profile_artifact_path()
        if load_default_artifact and artifact_path.exists():
            self._profiles = load_profile_artifact(artifact_path)
            self.source = str(artifact_path)
            return

        self._profiles = {}
        self.source = "empty"

    def get(self, user_id: str | None) -> dict[str, Any] | None:
        if not user_id:
            return None
        profile = self._profiles.get(user_id)
        return dict(profile) if profile else None
