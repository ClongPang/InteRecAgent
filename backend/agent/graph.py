"""LangGraph 状态图装配（AGT-001）。图构建集中在此，节点注册表不引入无价值抽象。"""
from __future__ import annotations

from collections.abc import Callable

from langgraph.graph import END, START, StateGraph

from ..application.ports import FxSource, ModelBackend, ProductSource, UnitOfWork
from .nodes.clarify import make_parse_intent_patch, need_clarification
from .nodes.decide import (
    make_filter_hard_constraints,
    make_merge_mission_state,
    make_normalize_and_deduplicate,
    make_rank_candidates,
)
from .nodes.evidence import make_compose_recommendation, make_verify_evidence
from .nodes.fetch import (
    make_build_search_plan,
    make_fetch_fx,
    make_fetch_products,
    make_receive_message,
)
from .nodes.persist import make_persist_decision_snapshot
from .state import MissionGraphState

# AGT-001 要求的显式节点集（图结构快照测试依赖此常量）
NODE_NAMES = (
    "receive_message",
    "parse_intent_patch",
    "merge_mission_state",
    "need_clarification",
    "build_search_plan",
    "fetch_products",
    "fetch_fx",
    "normalize_and_deduplicate",
    "filter_hard_constraints",
    "rank_candidates",
    "verify_evidence",
    "compose_recommendation",
    "persist_decision_snapshot",
)


def _route_after_clarification(state: MissionGraphState) -> str:
    return "clarify" if state.get("requires_clarification") else "search"


def build_graph(
    *,
    products: ProductSource,
    fx: FxSource,
    model_backend: ModelBackend,
    uow_factory: Callable[[], UnitOfWork],
    max_concurrency: int = 3,
):
    """组装完整状态图。依赖通过参数注入；节点不直接实例化任何基础设施。"""
    graph = StateGraph(MissionGraphState)

    graph.add_node("receive_message", make_receive_message(uow_factory))
    graph.add_node("parse_intent_patch", make_parse_intent_patch(model_backend))
    graph.add_node("merge_mission_state", make_merge_mission_state())
    graph.add_node("need_clarification", need_clarification)
    graph.add_node("build_search_plan", make_build_search_plan())
    graph.add_node("fetch_products", make_fetch_products(products, max_concurrency))
    graph.add_node("fetch_fx", make_fetch_fx(fx))
    graph.add_node("normalize_and_deduplicate", make_normalize_and_deduplicate())
    graph.add_node("filter_hard_constraints", make_filter_hard_constraints())
    graph.add_node("rank_candidates", make_rank_candidates())
    graph.add_node("verify_evidence", make_verify_evidence())
    graph.add_node("compose_recommendation", make_compose_recommendation())
    graph.add_node("persist_decision_snapshot", make_persist_decision_snapshot(uow_factory))

    graph.add_edge(START, "receive_message")
    graph.add_edge("receive_message", "parse_intent_patch")
    graph.add_edge("parse_intent_patch", "merge_mission_state")
    graph.add_edge("merge_mission_state", "need_clarification")
    graph.add_conditional_edges(
        "need_clarification",
        _route_after_clarification,
        {"clarify": "persist_decision_snapshot", "search": "build_search_plan"},
    )
    graph.add_edge("build_search_plan", "fetch_products")
    graph.add_edge("fetch_products", "fetch_fx")
    graph.add_edge("fetch_fx", "normalize_and_deduplicate")
    graph.add_edge("normalize_and_deduplicate", "filter_hard_constraints")
    graph.add_edge("filter_hard_constraints", "rank_candidates")
    graph.add_edge("rank_candidates", "verify_evidence")
    graph.add_edge("verify_evidence", "compose_recommendation")
    graph.add_edge("compose_recommendation", "persist_decision_snapshot")
    graph.add_edge("persist_decision_snapshot", END)

    return graph.compile()
