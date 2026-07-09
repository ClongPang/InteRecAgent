from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


@dataclass(frozen=True)
class Command:
    label: str
    args: list[str]
    cwd: Path = ROOT
    env: dict[str, str] = field(default_factory=dict)


def build_commands(args: argparse.Namespace) -> list[Command]:
    commands: list[Command] = []
    if args.metadata:
        build_args = [
            "uv",
            "run",
            "python",
            "-m",
            "backend.app.data_pipeline.catalog_builder",
            "--metadata",
            str(args.metadata),
            "--output",
            str(args.artifact_dir),
            "--target-min",
            str(args.target_min),
            "--target-max",
            str(args.target_max),
            "--demo-limit",
            str(args.demo_limit),
        ]
        if args.reviews:
            build_args.extend(["--reviews", str(args.reviews)])
        commands.append(
            Command("build catalog artifacts", build_args, env={"UV_CACHE_DIR": ".uv-cache"})
        )
        commands.append(
            Command(
                "catalog readiness",
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "backend.app.data_pipeline.catalog_readiness",
                    "--artifact-dir",
                    str(args.artifact_dir),
                    "--target-min",
                    str(args.target_min),
                    "--target-max",
                    str(args.target_max),
                    "--demo-limit",
                    str(args.demo_limit),
                ],
                env={"UV_CACHE_DIR": ".uv-cache"},
            )
        )
        args.include_artifact_gate = True

    if args.require_system_readiness and not args.metadata:
        commands.append(
            Command(
                "catalog readiness",
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "backend.app.data_pipeline.catalog_readiness",
                    "--artifact-dir",
                    str(args.artifact_dir),
                    "--target-min",
                    str(args.target_min),
                    "--target-max",
                    str(args.target_max),
                    "--demo-limit",
                    str(args.demo_limit),
                ],
                env={"UV_CACHE_DIR": ".uv-cache"},
            )
        )

    if args.build_index:
        index_args = [
            "uv",
            "run",
            "python",
            "-m",
            "backend.app.data_pipeline.vector_index_builder",
            "--catalog",
            str(args.artifact_dir / "normalized_catalog.jsonl"),
            "--output",
            str(args.index_dir),
        ]
        commands.append(
            Command("build vector index artifacts", index_args, env={"UV_CACHE_DIR": ".uv-cache"})
        )
        args.require_index = True

    if args.require_index:
        commands.append(
            Command(
                "vector index readiness",
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "backend.app.data_pipeline.vector_index_readiness",
                    "--artifact-dir",
                    str(args.index_dir),
                    "--min-products",
                    str(args.index_min_products),
                ],
                env={"UV_CACHE_DIR": ".uv-cache"},
            )
        )

    if args.generate_eval_cases:
        commands.append(
            Command(
                "generate evaluation task cases",
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "backend.app.services.evaluation_case_generator",
                    "--output",
                    str(args.eval_cases),
                    "--count",
                    str(args.eval_case_count),
                ],
                env={"UV_CACHE_DIR": ".uv-cache"},
            )
        )
        args.require_eval_cases = True

    if args.build_profiles:
        profile_args = [
            "uv",
            "run",
            "python",
            "-m",
            "backend.app.data_pipeline.profile_builder",
            "--reviews",
            str(args.reviews),
            "--output",
            str(args.profile_dir),
            "--min-reviews-per-user",
            str(args.profile_min_reviews_per_user),
            "--max-profiles",
            str(args.profile_max_profiles),
        ]
        catalog_path = args.artifact_dir / "normalized_catalog.jsonl"
        if args.metadata or catalog_path.exists():
            profile_args.extend(["--catalog", str(catalog_path)])
        commands.append(
            Command("build user profile artifacts", profile_args, env={"UV_CACHE_DIR": ".uv-cache"})
        )
        args.require_profiles = True

    if args.require_profiles:
        commands.append(
            Command(
                "profile readiness",
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "backend.app.data_pipeline.profile_readiness",
                    "--artifact-dir",
                    str(args.profile_dir),
                    "--min-profiles",
                    str(args.profile_min_profiles),
                ],
                env={"UV_CACHE_DIR": ".uv-cache"},
            )
        )

    if args.require_eval_cases:
        commands.append(
            Command(
                "evaluation task case readiness",
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "backend.app.services.evaluation_dataset_readiness",
                    "--path",
                    str(args.eval_cases),
                    "--min-cases",
                    str(args.eval_min_cases),
                    "--max-cases",
                    str(args.eval_max_cases),
                ],
                env={"UV_CACHE_DIR": ".uv-cache"},
            )
        )

    commands.extend([
        Command("backend deterministic tests", ["uv", "run", "pytest"], env={"UV_CACHE_DIR": ".uv-cache"}),
        Command("frontend typecheck", ["npm", "run", "typecheck"], cwd=FRONTEND),
        Command("frontend unit tests", ["npm", "test"], cwd=FRONTEND),
        Command("frontend responsive tests", ["npm", "run", "test:responsive"], cwd=FRONTEND),
        Command("frontend accessibility tests", ["npm", "run", "test:a11y"], cwd=FRONTEND),
        Command("frontend production build", ["npm", "run", "build"], cwd=FRONTEND),
    ])
    if not args.skip_e2e:
        commands.append(Command("frontend browser e2e", ["npm", "run", "test:e2e"], cwd=FRONTEND))
    if args.include_artifact_gate:
        commands.append(
            Command(
                "ready catalog artifact gate",
                ["uv", "run", "pytest", "tests/integration/", "-m", "artifact"],
                env={
                    "UV_CACHE_DIR": ".uv-cache",
                    "INTEREC_ARTIFACT_DIR": str(args.artifact_dir),
                    "INTEREC_CATALOG_PATH": str(args.artifact_dir / "normalized_catalog.jsonl"),
                    "INTEREC_TARGET_MIN": str(args.target_min),
                    "INTEREC_TARGET_MAX": str(args.target_max),
                    "INTEREC_DEMO_LIMIT": str(args.demo_limit),
                },
            )
        )
    return commands


def run_command(command: Command) -> None:
    print(f"\n==> {command.label}", flush=True)
    print(f"$ {format_command_for_plan(command)}", flush=True)
    env = os.environ.copy()
    env.update(command.env)
    subprocess.run(command.args, cwd=command.cwd, env=env, check=True)


def format_command_for_plan(command: Command) -> str:
    env_parts = [
        f"{name}={shlex.quote(value)}"
        for name, value in sorted(command.env.items())
    ]
    return " ".join(env_parts + [shlex.join(command.args)])


def runtime_artifact_env(args: argparse.Namespace) -> dict[str, str]:
    env: dict[str, str] = {}
    if args.metadata or args.include_artifact_gate:
        env["INTEREC_CATALOG_PATH"] = str(args.artifact_dir / "normalized_catalog.jsonl")
        env["INTEREC_TARGET_MIN"] = str(args.target_min)
        env["INTEREC_TARGET_MAX"] = str(args.target_max)
        env["INTEREC_DEMO_LIMIT"] = str(args.demo_limit)
    if args.build_index or args.require_index:
        env["INTEREC_INDEX_PATH"] = str(args.index_dir / "product_index.jsonl")
        env["INTEREC_INDEX_MIN_PRODUCTS"] = str(args.index_min_products)
    if args.build_profiles or args.require_profiles:
        env["INTEREC_PROFILE_PATH"] = str(args.profile_dir / "user_profiles.jsonl")
        env["INTEREC_PROFILE_MIN_PROFILES"] = str(args.profile_min_profiles)
    if args.generate_eval_cases or args.require_eval_cases:
        env["INTEREC_EVAL_CASES_PATH"] = str(args.eval_cases)
        env["INTEREC_EVAL_MIN_CASES"] = str(args.eval_min_cases)
        env["INTEREC_EVAL_MAX_CASES"] = str(args.eval_max_cases)
    return env


def apply_system_readiness_requirements(args: argparse.Namespace) -> None:
    if not args.require_system_readiness:
        return
    args.include_artifact_gate = True
    args.require_index = True
    args.require_eval_cases = True
    args.require_profiles = True


def run_live_integration(runtime_env: dict[str, str] | None = None) -> None:
    print("\n==> frontend live integration", flush=True)
    backend_env = os.environ.copy()
    backend_env["UV_CACHE_DIR"] = ".uv-cache"
    backend_env.update(runtime_env or {})
    backend = subprocess.Popen(
        [
            "uv",
            "run",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
        cwd=ROOT,
        env=backend_env,
    )
    try:
        wait_for_backend(backend)
        subprocess.run(["npm", "run", "test:integration"], cwd=FRONTEND, check=True)
    finally:
        backend.terminate()
        try:
            backend.wait(timeout=10)
        except subprocess.TimeoutExpired:
            backend.kill()
            backend.wait(timeout=10)


def wait_for_backend(process: subprocess.Popen, timeout_seconds: float = 20.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("backend server exited before live integration could run")
        try:
            with urlopen("http://127.0.0.1:8000/api/health", timeout=1) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"backend server did not become ready: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run InteRecAgent MVP validation gates.")
    parser.add_argument("--skip-e2e", action="store_true", help="Skip Playwright browser tests.")
    parser.add_argument(
        "--skip-live-integration",
        action="store_true",
        help="Skip frontend tests against a local FastAPI server.",
    )
    parser.add_argument(
        "--include-artifact-gate",
        action="store_true",
        help="Run the ready-catalog artifact gate. It skips until data/catalog is ready.",
    )
    parser.add_argument(
        "--require-system-readiness",
        action="store_true",
        help="Require catalog, vector index, evaluation cases, and profile artifacts before validation.",
    )
    parser.add_argument(
        "--metadata",
        type=Path,
        help="Build catalog artifacts from this metadata .jsonl or .jsonl.gz before validation.",
    )
    parser.add_argument(
        "--reviews",
        type=Path,
        help="Optional reviews .jsonl or .jsonl.gz path used while building catalog artifacts.",
    )
    parser.add_argument("--artifact-dir", type=Path, default=Path("data/catalog"))
    parser.add_argument("--target-min", type=int, default=20_000)
    parser.add_argument("--target-max", type=int, default=50_000)
    parser.add_argument("--demo-limit", type=int, default=50)
    parser.add_argument(
        "--build-index",
        action="store_true",
        help="Build deterministic vector index artifacts from the normalized catalog.",
    )
    parser.add_argument(
        "--require-index",
        action="store_true",
        help="Validate deterministic vector index artifacts before running tests.",
    )
    parser.add_argument("--index-dir", type=Path, default=Path("data/indexes"))
    parser.add_argument("--index-min-products", type=int, default=1)
    parser.add_argument(
        "--generate-eval-cases",
        action="store_true",
        help="Generate deterministic task evaluation cases before validation.",
    )
    parser.add_argument(
        "--require-eval-cases",
        action="store_true",
        help="Validate the task evaluation case JSONL before running tests.",
    )
    parser.add_argument("--eval-cases", type=Path, default=Path("data/eval/task_cases.jsonl"))
    parser.add_argument("--eval-case-count", type=int, default=140)
    parser.add_argument("--eval-min-cases", type=int, default=100)
    parser.add_argument("--eval-max-cases", type=int, default=300)
    parser.add_argument(
        "--build-profiles",
        action="store_true",
        help="Build internal user profile artifacts from --reviews before validation.",
    )
    parser.add_argument(
        "--require-profiles",
        action="store_true",
        help="Validate internal user profile artifacts before running tests.",
    )
    parser.add_argument("--profile-dir", type=Path, default=Path("data/profiles"))
    parser.add_argument("--profile-min-profiles", type=int, default=1)
    parser.add_argument("--profile-min-reviews-per-user", type=int, default=2)
    parser.add_argument("--profile-max-profiles", type=int, default=10_000)
    parser.add_argument("--print-plan", action="store_true", help="Print commands without running them.")
    args = parser.parse_args()
    apply_system_readiness_requirements(args)

    if args.build_profiles and not args.reviews:
        parser.error("--build-profiles requires --reviews")
    if args.build_index and not (args.metadata or (args.artifact_dir / "normalized_catalog.jsonl").exists()):
        parser.error("--build-index requires --metadata or an existing normalized catalog artifact")

    commands = build_commands(args)
    if not args.skip_live_integration:
        commands.append(
            Command(
                "frontend live integration",
                ["npm", "run", "test:integration"],
                cwd=FRONTEND,
                env=runtime_artifact_env(args),
            )
        )

    if args.print_plan:
        for command in commands:
            print(f"{command.label}: {format_command_for_plan(command)}")
        return 0

    for command in commands:
        if command.label == "frontend live integration":
            run_live_integration(command.env)
        else:
            run_command(command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
