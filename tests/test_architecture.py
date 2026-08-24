"""架构依赖方向测试（ARC-001/ARC-002、AC-010）。

复用 scripts/check_architecture.py 的扫描逻辑（同一事实源），验证：
- domain 不导入 api/application/agent/infrastructure/adapters；
- application 不导入 api/agent/infrastructure/adapters；
- 核心 Port 存在且关键方法为异步。
"""
from __future__ import annotations

import inspect

import pytest

from scripts.check_architecture import (
    ALLOWED_TARGETS,
    BACKEND,
    LAYERS,
    LEGACY,
    all_backend_py,
    backend_imports,
    module_layer,
)

pytestmark = pytest.mark.architecture


def _rel(path) -> str:
    return str(path.relative_to(BACKEND))


@pytest.mark.parametrize("path", all_backend_py(), ids=_rel)
def test_import_boundaries(path) -> None:
    layer = module_layer(path)
    allowed = ALLOWED_TARGETS.get(layer, LAYERS | LEGACY)
    imported = backend_imports(path)
    violations = imported - allowed
    assert not violations, f"{_rel(path)} 违反依赖边界: 导入 {sorted(violations)}"


def test_required_ports_exist_and_are_async() -> None:
    """BE-002：核心 Port 必须存在且关键方法为异步。"""
    from backend.application import ports

    required = [
        "MissionRunner",
        "RunDispatcher",
        "ProductSource",
        "FxSource",
        "ModelBackend",
        "MissionRepository",
        "MissionEventBroker",
        "RunTextHub",
        "UnitOfWork",
    ]
    for name in required:
        assert hasattr(ports, name), f"缺少 Port: {name}"

    assert inspect.iscoroutinefunction(ports.ProductSource.search)
    assert inspect.iscoroutinefunction(ports.FxSource.get_rate)
    assert inspect.iscoroutinefunction(ports.MissionRunner.run)
    assert inspect.iscoroutinefunction(ports.RunDispatcher.dispatch)
    assert inspect.iscoroutinefunction(ports.RunDispatcher.cancel)
    assert inspect.iscoroutinefunction(ports.MissionRepository.get)
    assert inspect.iscoroutinefunction(ports.ModelBackend.parse_decision)
    assert inspect.iscoroutinefunction(ports.ModelBackend.pick_probe)
    assert inspect.iscoroutinefunction(ports.ModelBackend.parse_turn)
    assert inspect.iscoroutinefunction(ports.ModelBackend.complete_json)
    assert inspect.iscoroutinefunction(ports.MissionEventBroker.wait)


def test_application_does_not_import_agent_or_infrastructure() -> None:
    """ARC-002/DEC-009：Application 包不得导入 backend.agent / backend.infrastructure。"""
    for path in all_backend_py():
        if module_layer(path) == "application":
            imported = backend_imports(path)
            assert not (imported & {"agent", "infrastructure"}), (
                f"{_rel(path)} 导入了 Agent/Infrastructure"
            )


def test_settings_is_only_environment_reader() -> None:
    """ARC-006：只有 bootstrap/settings.py 读取环境变量。"""
    banned = ("os.environ", "os.getenv", "getenv(", "environ[")
    for path in all_backend_py():
        if path.name == "settings.py" and "bootstrap" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for pat in banned:
            assert pat not in text, f"{_rel(path)} 读取环境变量（ARC-006 违规）: {pat}"


def test_talk_and_present_do_not_call_product_detail() -> None:
    """阶段 4：比较/提问只引用候选快照，不得打详情富化。"""
    banned = ("get_product(", "products.compare", "/v1/products/compare")
    paths = [
        BACKEND / "application" / "services" / "grounded.py",
        BACKEND / "application" / "services" / "present.py",
        BACKEND / "application" / "services" / "dialogue.py",
        BACKEND / "agent" / "nodes" / "dialogue.py",
        BACKEND / "agent" / "nodes" / "decide.py",
        BACKEND / "agent" / "nodes" / "evidence.py",
    ]
    for path in paths:
        text = path.read_text(encoding="utf-8")
        for pat in banned:
            assert pat not in text, f"{_rel(path)} 不应调用详情/比较接口: {pat}"


def test_only_explicit_v2_execution_path_can_be_wired() -> None:
    """Full release must not retain a callable legacy graph or traffic splitter."""
    forbidden_files = [
        BACKEND / "agent" / "nodes" / "execute.py",
        BACKEND / "agent" / "nodes" / "clarify.py",
        BACKEND / "agent" / "nodes" / "parse_intent.py",
        BACKEND / "application" / "services" / "execute_ops.py",
    ]
    assert not any(path.exists() for path in forbidden_files)

    scanned = [
        BACKEND / "agent" / "graph.py",
        BACKEND / "agent" / "runner.py",
        BACKEND / "bootstrap" / "container.py",
        BACKEND / "bootstrap" / "settings.py",
    ]
    banned = (
        "CanaryMissionRunner",
        "legacy_execute_ops",
        "explicit_graph_canary_percent",
        "rollout_cohort",
    )
    for path in scanned:
        source = path.read_text(encoding="utf-8")
        for token in banned:
            assert token not in source, f"{_rel(path)} reintroduced legacy route: {token}"


def test_persist_is_a_validator_not_an_artifact_fallback_factory() -> None:
    source = (BACKEND / "agent" / "nodes" / "persist.py").read_text(encoding="utf-8")
    banned = (
        "build_recommendation_answer_plan",
        "build_candidate_claim_ledger",
        '"normalized_fallback"',
    )
    for token in banned:
        assert token not in source, f"persist reintroduced artifact fallback: {token}"
