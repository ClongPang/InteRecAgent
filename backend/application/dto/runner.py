from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class IntentPatch(BaseModel):
    """从用户输入得到的结构化条件增量（规格 §6.4）。不直接覆盖任务状态，由 Agent 合并。"""

    query: str | None = None
    budget_cny: float | None = None
    markets: list[str] | None = None
    preference: str | None = None  # balanced | battery | noise | lowest
    only_in_stock: bool | None = None
    confidence: float = 1.0
    source: str = "deterministic"  # deterministic | model
    requires_clarification: bool = False
    clarification_question: str | None = None


class RecommendationDraft(BaseModel):
    """模型或模板只允许输出的推荐草稿（规格 §6.5）。最终响应由后端校验并重组。"""

    primary_snapshot_id: str
    alternative_snapshot_ids: list[str] = Field(default_factory=list)
    rationale: list[str] = Field(default_factory=list)
    tradeoffs: list[str] = Field(default_factory=list)
    cited_evidence_ids: list[str] = Field(default_factory=list)


class SearchPlan(BaseModel):
    """确定性生成的搜索计划。"""

    query: str
    markets: list[str] = Field(default_factory=lambda: ["US"])
    mode: str = "keyword"
    limit: int = 20
    budget_cny: float | None = None


class RunnerStatus(StrEnum):
    COMPLETED = "completed"
    DEGRADED = "degraded"
    FAILED = "failed"
    SUPERSEDED = "superseded"
    INTERRUPTED = "interrupted"


class RunnerResult(BaseModel):
    """MissionRunner 一次运行的终态。"""

    status: RunnerStatus
    candidate_set_id: str | None = None
    recommendation_run_id: str | None = None
    warnings: list[str] = Field(default_factory=list)
