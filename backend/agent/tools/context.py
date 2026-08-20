"""研究循环的短生命周期工作上下文（Shared Candidate Bus）。

候选商品按对象持有于此，只把「ID + 极简 brief」交给 LLM，避免把整份商品列表塞进
每一步的 prompt（成本/延迟/幻觉三重失控）。工具读写本上下文，不产生持久化副作用；
副作用只在确定性 commit gate（persist 节点）发生。

池子语义是「本趟研究已并入的候选」，不是「最近一次检索结果」。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ...application.dto.mission import ShoppingMission
from ...application.dto.runner import SearchPlan
from ...domain.models import FxSnapshot, NormalizedProduct


@dataclass
class ResearchLimits:
    """研究环硬门槛。改数字只改这里，不要写进提示词。"""

    pool_threshold: int = 25
    max_searches: int = 3
    top_k: int = 6
    max_judge_batch: int = 40


@dataclass
class ResearchContext:
    mission: ShoppingMission
    plan: SearchPlan

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
    limits: ResearchLimits = field(default_factory=ResearchLimits)

    searched: bool = False
    converted: bool = False
    finalized: bool = False
    stale: bool = False
    recall_count: int = 0
    relaxed_native_cap: bool = False
    converted_products: list[NormalizedProduct] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.current_query:
            self.current_query = self.plan.query or ""

    def add_warnings(self, items: list[str] | str) -> None:
        if isinstance(items, str):
            items = [items]
        for item in items:
            if item and item not in self.warnings:
                self.warnings.append(item)
