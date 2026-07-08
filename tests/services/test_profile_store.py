import json

import pytest

from backend.app.services.profile_store import ProfileStore, load_profile_artifact


def write_profiles(path, rows):
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def test_profile_store_loads_user_profile_artifact(tmp_path):
    profile_path = tmp_path / "user_profiles.jsonl"
    write_profiles(
        profile_path,
        [
            {
                "user_id": "U1",
                "review_count": 2,
                "preferred_categories": [{"category": "Mouse", "count": 2}],
                "positive_product_ids": ["prod_mouse_001"],
                "negative_product_ids": [],
                "recent_product_ids": ["prod_mouse_001"],
            }
        ],
    )

    store = ProfileStore(profile_path=profile_path)

    assert store.source == str(profile_path)
    assert store.get("U1")["positive_product_ids"] == ["prod_mouse_001"]
    assert store.get("missing") is None


def test_profile_store_uses_env_profile_path(monkeypatch, tmp_path):
    profile_path = tmp_path / "env_profiles.jsonl"
    write_profiles(profile_path, [{"user_id": "ENV_USER", "review_count": 1}])
    monkeypatch.setenv("INTEREC_PROFILE_PATH", str(profile_path))

    store = ProfileStore()

    assert store.source == str(profile_path)
    assert store.get("ENV_USER")["review_count"] == 1


def test_profile_store_falls_back_to_empty_when_artifact_missing(tmp_path):
    store = ProfileStore(profile_path=tmp_path / "missing.jsonl")

    assert store.source == "empty"
    assert store.get("U1") is None


def test_profile_artifact_validation_reports_line_number(tmp_path):
    profile_path = tmp_path / "broken_profiles.jsonl"
    profile_path.write_text('{"user_id": "U1"\n', encoding="utf-8")

    with pytest.raises(ValueError, match=r"broken_profiles\.jsonl:1"):
        load_profile_artifact(profile_path)
