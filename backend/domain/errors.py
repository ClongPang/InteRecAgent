from __future__ import annotations

"""领域错误类型。领域层只抛出这里定义的异常，外层负责映射为错误契约。"""


class DomainError(Exception):
    """领域层异常基类。"""


class MissionVersionConflict(DomainError):
    """任务约束版本冲突：旧版本运行不得覆盖新版本任务。"""


class InvalidConstraint(DomainError):
    """约束非法（市场不在白名单、预算越界、比较数量非 2–4 等）。"""


class HardConstraintViolation(DomainError):
    """硬约束冲突（不应发生，发生时说明调用方逻辑错误）。"""
