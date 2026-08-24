from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from ...domain.models import DEFAULT_MARKETS
from .belief import SoftPref, SpecGate


class IntentPatch(BaseModel):
    """从用户输入得到的结构化条件增量（规格 §6.4）。不直接覆盖任务状态，由 Agent 合并。"""

    query: str | None = None
    budget_cny: float | None = None
    markets: list[str] | None = None
    preference: str | None = None  # balanced | battery | noise | lowest
    only_in_stock: bool | None = None
    merchants: list[str] | None = None
    exclude_terms: list[str] | None = None
    use_case: str | None = None
    spec_gates: list[SpecGate] | None = None
    price_stance: str | None = None
    # 开放式软偏好维度（防水/轻便/游戏低延迟/送礼…）。由 LLM 给出 attr+cues，
    # 不再受 preference 枚举限制；确定性打分按 cues 通用匹配。见 §5.1 天花板。
    soft_prefs: list[SoftPref] | None = None
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
    """确定性生成的搜索计划。mode 是 BuyWhere 参数；recall_mode 是对用户的质量承诺。"""

    query: str
    query_variants: list[str] = Field(default_factory=list)
    markets: list[str] = Field(default_factory=lambda: list(DEFAULT_MARKETS))
    mode: str = "keyword"
    limit: int = 20
    budget_cny: float | None = None
    recall_mode: str = "exploratory"  # precise | exploratory


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
    metadata: dict[str, Any] = Field(default_factory=dict)
