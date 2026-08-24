"""Assemble the sole production Goal V2 LangGraph execution path."""
from __future__ import annotations

from collections.abc import Callable

from langgraph.graph import END, START, StateGraph

from ..application.ports import FxSource, ModelBackend, ProductSource, RunTextHub, UnitOfWork
from ..domain.product_ontology import SUPPORTED_ITEM_TYPES
from .nodes.explicit_v2 import (
    assess_coverage,
    assess_next_action,
    build_answer_plan,
    build_semantic_profile,
    completion_check,
    make_answer_from_evidence,
    make_clarify_one_slot,
    make_render_response,
    make_retrieve_buywhere,
    make_reuse_evidence,
    make_verify_claims,
    normalize_observation,
    plan_research,
    qualify_candidates,
    rank_feasible,
)
from .nodes.fetch import make_receive_message
from .nodes.goal_commit import make_commit_goal_revision
from .nodes.persist import make_persist_decision_snapshot
from .nodes.world import make_decide
from .state import MissionGraphState

NODE_NAMES = (
    "receive_message",
    "decide",
    "commit_goal_revision",
    "assess_next_action",
    "answer_from_evidence",
    "clarify_one_slot",
    "plan_research",
    "retrieve_buywhere",
    "normalize_observation",
    "build_semantic_profile",
    "qualify_candidates",
    "assess_coverage",
    "rank_feasible",
    "reuse_evidence",
    "build_answer_plan",
    "verify_claims",
    "render_response",
    "completion_check",
    "persist_decision_snapshot",
)


def build_graph(
    *,
    products: ProductSource,
    fx: FxSource,
    model_backend: ModelBackend,
    uow_factory: Callable[[], UnitOfWork],
    max_concurrency: int = 3,
    text_hub: RunTextHub | None = None,
    enabled_item_types: frozenset[str] | None = None,
    max_wall_time_ms: int = 20_000,
):
    enabled_item_types = (
        SUPPORTED_ITEM_TYPES if enabled_item_types is None else enabled_item_types
    )
    """Assemble the sole production Goal V2 graph."""
    graph = StateGraph(MissionGraphState)

    graph.add_node("receive_message", make_receive_message(uow_factory))
    graph.add_node("decide", make_decide(model_backend))
    graph.add_node(
        "commit_goal_revision",
        make_commit_goal_revision(uow_factory, enabled_item_types=enabled_item_types),
    )
    graph.add_node("assess_next_action", assess_next_action)
    graph.add_node("answer_from_evidence", make_answer_from_evidence())
    graph.add_node("clarify_one_slot", make_clarify_one_slot(model_backend))
    graph.add_node("plan_research", plan_research)
    graph.add_node(
        "retrieve_buywhere",
        make_retrieve_buywhere(
            products,
            fx,
            model_backend,
            uow_factory,
            max_concurrency=max_concurrency,
            enabled_item_types=enabled_item_types,
            max_wall_time_ms=max_wall_time_ms,
        ),
    )
    graph.add_node("normalize_observation", normalize_observation)
    graph.add_node("build_semantic_profile", build_semantic_profile)
    graph.add_node("qualify_candidates", qualify_candidates)
    graph.add_node("assess_coverage", assess_coverage)
    graph.add_node("rank_feasible", rank_feasible)
    graph.add_node(
        "reuse_evidence", make_reuse_evidence(enabled_item_types=enabled_item_types)
    )
    graph.add_node("build_answer_plan", build_answer_plan)
    graph.add_node("verify_claims", make_verify_claims())
    graph.add_node("render_response", make_render_response())
    graph.add_node("completion_check", completion_check)
    graph.add_node(
        "persist_decision_snapshot",
        make_persist_decision_snapshot(uow_factory, text_hub=text_hub),
    )

    graph.add_edge(START, "receive_message")
    graph.add_edge("receive_message", "decide")
    graph.add_edge("decide", "commit_goal_revision")
    graph.add_conditional_edges(
        "commit_goal_revision",
        lambda state: "blocked" if state.get("goal_revision_blocked") else "continue",
        {"blocked": END, "continue": "assess_next_action"},
    )
    graph.add_conditional_edges(
        "assess_next_action",
        lambda state: str(state.get("turn_route") or "research"),
        {
            "clarify": "clarify_one_slot",
            "talk": "answer_from_evidence",
            "research": "plan_research",
            "refilter": "reuse_evidence",
            "rerank": "reuse_evidence",
        },
    )
    graph.add_edge("plan_research", "retrieve_buywhere")
    graph.add_edge("retrieve_buywhere", "normalize_observation")
    graph.add_conditional_edges(
        "normalize_observation",
        lambda state: "blocked" if state.get("completion_blocked") else "continue",
        {"blocked": "completion_check", "continue": "build_semantic_profile"},
    )
    graph.add_edge("build_semantic_profile", "qualify_candidates")
    graph.add_edge("qualify_candidates", "assess_coverage")
    graph.add_edge("assess_coverage", "rank_feasible")
    for node in ("rank_feasible", "reuse_evidence", "answer_from_evidence", "clarify_one_slot"):
        graph.add_edge(node, "build_answer_plan")
    graph.add_edge("build_answer_plan", "verify_claims")
    graph.add_edge("verify_claims", "render_response")
    graph.add_edge("render_response", "completion_check")
    graph.add_edge("completion_check", "persist_decision_snapshot")
    graph.add_edge("persist_decision_snapshot", END)

    return graph.compile()
