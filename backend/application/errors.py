from __future__ import annotations

"""应用层错误。API/Agent 只捕获这里定义的异常，映射为稳定错误契约。"""


class ApplicationError(Exception):
    """应用层异常基类。"""


class MissionNotFound(ApplicationError):
    """任务不存在或不属于当前 owner（跨 owner 统一 404，不泄漏存在性）。"""


class MissionVersionConflict(ApplicationError):
    """约束版本冲突。"""


class InvalidComparison(ApplicationError):
    """比较集合数量非法（必须是 2–4 件）。"""


class NothingToUndo(ApplicationError):
    """没有可撤销的条件变更。"""


class RecommendationNotFound(ApplicationError):
    """当前任务尚无已验证推荐。"""


class SnapshotNotFound(ApplicationError):
    """商品快照不存在。"""


class InvalidAnonymousUser(ApplicationError):
    """匿名用户标识不是合法 UUID。"""


class DispatcherNotAccepting(ApplicationError):
    """调度器已停止接收新运行（进程正在关闭）。"""


class RunNotRunning(ApplicationError):
    """当前没有可取消的运行（已结束、已 supersede，或不是 active_run）。"""


class ModelUnavailableError(ApplicationError):
    """模型后端未配置或能力不可用。Agent 捕获后走确定性 fallback。"""


class UpstreamUnavailableError(ApplicationError):
    """上游源不可用（网络/超时/限流/上游错误/鉴权失败）。

    由 Infrastructure 适配器抛出、Application 服务捕获并降级。字段对应规格 §6.6 错误契约。
    """

    def __init__(
        self,
        code: str,
        *,
        category: str = "upstream",
        retryable: bool = True,
        status_code: int | None = None,
        retry_after: float | None = None,
        user_message: str | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.category = category
        self.retryable = retryable
        self.status_code = status_code
        self.retry_after = retry_after
        self.user_message = user_message
