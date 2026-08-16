#!/usr/bin/env python3
"""架构依赖方向检查（ARC-001/ARC-002、AC-010）。

独立脚本，供 Makefile / CI 调用；tests/test_architecture.py 复用这里的逻辑，
避免两处定义漂移。用 AST 扫描 backend 源码顶层导入，不执行被检代码。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"

# backend.* 顶层包作为层的边界；cli/service/main 是待重构的遗留入口，允许访问所有层
LAYERS = {"api", "application", "agent", "infrastructure", "adapters", "domain", "bootstrap"}
LEGACY = {"cli", "service", "main"}

ALLOWED_TARGETS: dict[str, set[str]] = {
    "domain": set(),  # 领域只允许 stdlib / 第三方库 / domain 内部
    "application": {"application", "domain"},
    "api": {"application", "domain"},
    "agent": {"application", "domain"},
    "infrastructure": {"application", "domain"},
    "adapters": {"domain"},
    "bootstrap": LAYERS | {"bootstrap"},
}


def module_layer(path: Path) -> str:
    return path.relative_to(BACKEND).parts[0]


def backend_imports(path: Path) -> set[str]:
    """收集模块顶层 `backend.<layer>` 导入的第一层名字。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    targets: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("backend"):
            targets.add(node.module.split(".")[1])
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("backend"):
                    targets.add(alias.name.split(".")[1])
    return targets


def all_backend_py() -> list[Path]:
    return sorted(p for p in BACKEND.rglob("*.py") if p.suffix == ".py")


def find_violations() -> list[str]:
    violations: list[str] = []
    for path in all_backend_py():
        layer = module_layer(path)
        allowed = ALLOWED_TARGETS.get(layer, LAYERS | LEGACY)
        bad = backend_imports(path) - allowed
        if bad:
            violations.append(f"{path.relative_to(BACKEND)}: 导入 {sorted(bad)}")
    return violations


def main() -> int:
    violations = find_violations()
    if violations:
        for v in violations:
            print(f"[FAIL] {v}", file=sys.stderr)
        return 1
    print("architecture check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
