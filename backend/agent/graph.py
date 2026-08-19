"""LangGraph 状态图装配（AGT-001）。检索是 research 子图，不是每句话的默认路径。"""
from __future__ import annotations

from collections.abc import Callable

from langgraph.graph import END, START, StateGraph

from ..application.ports import FxSource, ModelBackend, ProductSource, UnitOfWork
from .nodes.decide import (
    make_filter_hard_constraints,
    make_merge_mission_state,
    make_normalize_and_deduplicate,
    make_rank_candidates,
)
from .nodes.dialogue import (
    make_classify_dialogue_act,
    make_compose_grounded_reply,
    make_load_cached_candidates,
    route_turn,
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

NODE_NAMES = (
    "receive_message",
    "classify_dialogue_act",
    "merge_mission_state",
    "route_turn",
    "load_cached_candidates",
    "compose_grounded_reply",
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


def _route_after_turn(state: MissionGraphState) -> str:
    return state.get("turn_route") or "research"


def _route_after_cache(state: MissionGraphState) -> str:
    return "talk" if state.get("turn_route") == "talk" else "refilter"


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
    graph.add_node("classify_dialogue_act", make_classify_dialogue_act(model_backend))
    graph.add_node("merge_mission_state", make_merge_mission_state())
    graph.add_node("route_turn", route_turn)
    graph.add_node("load_cached_candidates", make_load_cached_candidates())
    graph.add_node("compose_grounded_reply", make_compose_grounded_reply())
    graph.add_node("build_search_plan", make_build_search_plan())
    graph.add_node("fetch_products", make_fetch_products(products, max_concurrency))
    graph.add_node("fetch_fx", make_fetch_fx(fx))
    graph.add_node("normalize_and_deduplicate", make_normalize_and_deduplicate())
    graph.add_node("filter_hard_constraints", make_filter_hard_constraints())
    graph.add_node("rank_candidates", make_rank_candidates())
    graph.add_node("verify_evidence", make_verify_evidence())
    graph.add_node("compose_recommendation", make_compose_recommendation(model_backend))
    graph.add_node("persist_decision_snapshot", make_persist_decision_snapshot(uow_factory))

    graph.add_edge(START, "receive_message")
    graph.add_edge("receive_message", "classify_dialogue_act")
    graph.add_edge("classify_dialogue_act", "merge_mission_state")
    graph.add_edge("merge_mission_state", "route_turn")
    graph.add_conditional_edges(
        "route_turn",
        _route_after_turn,
        {
            "clarify": "persist_decision_snapshot",
            "talk": "load_cached_candidates",
            "refilter": "load_cached_candidates",
            "rerank": "load_cached_candidates",
            "research": "build_search_plan",
        },
    )
    graph.add_conditional_edges(
        "load_cached_candidates",
        _route_after_cache,
        {
            "talk": "compose_grounded_reply",
            "refilter": "filter_hard_constraints",
        },
    )
    graph.add_edge("compose_grounded_reply", "persist_decision_snapshot")
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
