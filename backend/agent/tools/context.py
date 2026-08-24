"""研究循环的短生命周期工作上下文（Shared Candidate Bus）。

候选商品按对象持有于此，只把「ID + 极简 brief」交给 LLM，避免把整份商品列表塞进
每一步的 prompt（成本/延迟/幻觉三重失控）。工具读写本上下文，不产生持久化副作用；
副作用只在确定性 commit gate（persist 节点）发生。

池子语义是「本趟研究已并入的候选」，不是「最近一次检索结果」。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic

from ...application.dto.coverage import GoalCoverage
from ...application.dto.mission import ShoppingMission
from ...application.dto.qualification import CandidateQualification
from ...application.dto.research import ResearchProposal, ResearchQueryTrace
from ...application.dto.runner import SearchPlan
from ...application.dto.search import ProductObservation, SearchExecution
from ...domain.models import FxSnapshot, NormalizedProduct
from ...domain.product_ontology import SUPPORTED_ITEM_TYPES


@dataclass
class ResearchLimits:
    """研究环硬门槛。改数字只改这里，不要写进提示词。"""

    pool_threshold: int = 25
    max_searches: int = 2
    top_k: int = 6
    max_judge_batch: int = 40
    minimum_eligible: int = 3
    max_evidence_fetches: int = 5
    max_total_requests: int = 6
    max_wall_time_ms: int = 20_000
    max_consecutive_no_gain: int = 2
    max_model_calls: int = 6
    max_estimated_tokens: int = 12_000


@dataclass
class ResearchContext:
    mission: ShoppingMission
    plan: SearchPlan
    enabled_item_types: frozenset[str] = field(
        default_factory=lambda: SUPPORTED_ITEM_TYPES
    )

    products: list[NormalizedProduct] = field(default_factory=list)
    batch: list[NormalizedProduct] = field(default_factory=list)
    pool: list[NormalizedProduct] = field(default_factory=list)
    rates: dict[str, FxSnapshot] = field(default_factory=dict)
    fx_failed_currencies: list[str] = field(default_factory=list)
    failed_markets: list[str] = field(default_factory=list)
    ranked: list[NormalizedProduct] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    current_query: str = ""
    rewritten_queries: list[str] = field(default_factory=list)
    search_count: int = 0
    request_count: int = 0
    model_call_count: int = 0
    estimated_token_count: int = 0
    consecutive_no_gain: int = 0
    marginal_unique_observations: int = 0
    marginal_eligible_count: int = 0
    eligible_count_seen: int = 0
    stop_reason: str | None = None
    started_at: float = field(default_factory=monotonic)
    limits: ResearchLimits = field(default_factory=ResearchLimits)

    searched: bool = False
    converted: bool = False
    finalized: bool = False
    stale: bool = False
    recall_count: int = 0
    relaxed_native_cap: bool = False
    converted_products: list[NormalizedProduct] = field(default_factory=list)
    qualifications: dict[str, CandidateQualification] = field(default_factory=dict)
    candidate_markets: dict[str, str] = field(default_factory=dict)
    evidence_candidates: dict[str, NormalizedProduct] = field(default_factory=dict)
    evidence_attempted_ids: set[str] = field(default_factory=set)
    goal_coverage: GoalCoverage | None = None
    query_trace: list[ResearchQueryTrace] = field(default_factory=list)
    proposals: list[ResearchProposal] = field(default_factory=list)
    search_executions: list[SearchExecution] = field(default_factory=list)
    product_observations: dict[str, ProductObservation] = field(default_factory=dict)
    semantic_profile_proposals: dict[str, dict] = field(default_factory=dict)
    semantic_profile_shadow: dict[str, dict] = field(default_factory=dict)
    semantic_shadow_stats: dict[str, int] = field(
        default_factory=lambda: {
            "attempted_count": 0,
            "proposal_count": 0,
            "invalid_proposal_count": 0,
            "raw_evidence_span_count": 0,
            "valid_evidence_span_count": 0,
        }
    )

    def __post_init__(self) -> None:
        if not self.current_query:
            self.current_query = self.plan.query or ""

    def add_warnings(self, items: list[str] | str) -> None:
        if isinstance(items, str):
            items = [items]
        for item in items:
            if item and item not in self.warnings:
                self.warnings.append(item)

    def wall_time_exhausted(self) -> bool:
        return (monotonic() - self.started_at) * 1000 >= self.limits.max_wall_time_ms

    def remaining_time_ms(self) -> int:
        elapsed = round((monotonic() - self.started_at) * 1000)
        return max(0, self.limits.max_wall_time_ms - elapsed)

    def reserve_model_call(self, *, system: str, user: str) -> bool:
        estimated = max(1, (len(system) + len(user) + 3) // 4)
        if self.model_call_count >= self.limits.max_model_calls:
            return False
        if self.estimated_token_count + estimated > self.limits.max_estimated_tokens:
            return False
        self.model_call_count += 1
        self.estimated_token_count += estimated
        return True
