from argparse import Namespace
from pathlib import Path

from scripts.validate_mvp import (
    apply_system_readiness_requirements,
    build_commands,
    Command,
    format_command_for_plan,
    runtime_artifact_env,
)


def _args(**overrides):
    defaults = {
        "metadata": None,
        "include_artifact_gate": False,
        "require_system_readiness": False,
        "artifact_dir": Path("data/catalog"),
        "target_min": 20_000,
        "target_max": 50_000,
        "demo_limit": 50,
        "build_index": False,
        "require_index": False,
        "index_dir": Path("data/indexes"),
        "index_min_products": 1,
        "build_profiles": False,
        "require_profiles": False,
        "profile_dir": Path("data/profiles"),
        "profile_min_profiles": 1,
        "generate_eval_cases": False,
        "require_eval_cases": False,
        "eval_cases": Path("data/eval/task_cases.jsonl"),
        "eval_min_cases": 100,
        "eval_max_cases": 300,
        "skip_e2e": False,
    }
    defaults.update(overrides)
    return Namespace(**defaults)


def test_runtime_artifact_env_is_empty_for_fixture_only_validation():
    assert runtime_artifact_env(_args()) == {}


def test_runtime_artifact_env_points_live_backend_at_catalog_gate_artifact():
    env = runtime_artifact_env(
        _args(
            include_artifact_gate=True,
            artifact_dir=Path("tmp/catalog"),
            target_min=500,
            target_max=800,
            demo_limit=12,
        )
    )

    assert env == {
        "INTEREC_CATALOG_PATH": "tmp/catalog/normalized_catalog.jsonl",
        "INTEREC_TARGET_MIN": "500",
        "INTEREC_TARGET_MAX": "800",
        "INTEREC_DEMO_LIMIT": "12",
    }


def test_runtime_artifact_env_points_live_backend_at_all_generated_artifacts():
    env = runtime_artifact_env(
        _args(
            metadata=Path("raw/meta.jsonl.gz"),
            build_index=True,
            index_dir=Path("tmp/indexes"),
            index_min_products=25,
            build_profiles=True,
            profile_dir=Path("tmp/profiles"),
            profile_min_profiles=10,
            require_eval_cases=True,
            eval_cases=Path("tmp/eval/custom_task_cases.jsonl"),
            eval_min_cases=50,
            eval_max_cases=75,
        )
    )

    assert env == {
        "INTEREC_CATALOG_PATH": "data/catalog/normalized_catalog.jsonl",
        "INTEREC_TARGET_MIN": "20000",
        "INTEREC_TARGET_MAX": "50000",
        "INTEREC_DEMO_LIMIT": "50",
        "INTEREC_INDEX_PATH": "tmp/indexes/product_index.jsonl",
        "INTEREC_INDEX_MIN_PRODUCTS": "25",
        "INTEREC_PROFILE_PATH": "tmp/profiles/user_profiles.jsonl",
        "INTEREC_PROFILE_MIN_PROFILES": "10",
        "INTEREC_EVAL_CASES_PATH": "tmp/eval/custom_task_cases.jsonl",
        "INTEREC_EVAL_MIN_CASES": "50",
        "INTEREC_EVAL_MAX_CASES": "75",
    }


def test_require_system_readiness_enables_all_artifact_gates():
    args = _args(require_system_readiness=True)

    apply_system_readiness_requirements(args)
    commands = build_commands(args)

    labels = [command.label for command in commands]
    assert args.include_artifact_gate is True
    assert args.require_index is True
    assert args.require_eval_cases is True
    assert args.require_profiles is True
    assert labels[:4] == [
        "catalog readiness",
        "vector index readiness",
        "profile readiness",
        "evaluation task case readiness",
    ]
    assert "ready catalog artifact gate" in labels
    assert runtime_artifact_env(args) == {
        "INTEREC_CATALOG_PATH": "data/catalog/normalized_catalog.jsonl",
        "INTEREC_TARGET_MIN": "20000",
        "INTEREC_TARGET_MAX": "50000",
        "INTEREC_DEMO_LIMIT": "50",
        "INTEREC_INDEX_PATH": "data/indexes/product_index.jsonl",
        "INTEREC_INDEX_MIN_PRODUCTS": "1",
        "INTEREC_PROFILE_PATH": "data/profiles/user_profiles.jsonl",
        "INTEREC_PROFILE_MIN_PROFILES": "1",
        "INTEREC_EVAL_CASES_PATH": "data/eval/task_cases.jsonl",
        "INTEREC_EVAL_MIN_CASES": "100",
        "INTEREC_EVAL_MAX_CASES": "300",
    }


def test_format_command_for_plan_prints_environment_before_command():
    line = format_command_for_plan(
        Command(
            "demo",
            ["uv", "run", "pytest"],
            env={"INTEREC_TARGET_MIN": "20000", "INTEREC_CATALOG_PATH": "data/catalog/a b.jsonl"},
        )
    )

    assert line.startswith("INTEREC_CATALOG_PATH='data/catalog/a b.jsonl' INTEREC_TARGET_MIN=20000 ")
    assert line.endswith("uv run pytest")
