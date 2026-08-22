"""LangGraph 状态图装配（AGT-001）。检索是 execute 内的工具，不是每句话的默认路径。"""
from __future__ import annotations

from collections.abc import Callable

from langgraph.graph import END, START, StateGraph

from ..application.ports import FxSource, ModelBackend, ProductSource, RunTextHub, UnitOfWork
from .nodes.execute import make_decide, make_execute_ops
from .nodes.fetch import make_receive_message
from .nodes.persist import make_persist_decision_snapshot
from .state import MissionGraphState

NODE_NAMES = (
    "receive_message",
    "decide",
    "execute_ops",
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
):
    """组装完整状态图。五条计算支路留在 execute_ops 内，外层不再按 kind 查边。"""
    graph = StateGraph(MissionGraphState)

    graph.add_node("receive_message", make_receive_message(uow_factory))
    graph.add_node("decide", make_decide(model_backend))
    graph.add_node(
        "execute_ops",
        make_execute_ops(
            products,
            fx,
            model_backend,
            uow_factory,
            max_concurrency=max_concurrency,
            text_hub=text_hub,
        ),
    )
    graph.add_node(
        "persist_decision_snapshot",
        make_persist_decision_snapshot(uow_factory, text_hub=text_hub),
    )

    graph.add_edge(START, "receive_message")
    graph.add_edge("receive_message", "decide")
    graph.add_edge("decide", "execute_ops")
    graph.add_edge("execute_ops", "persist_decision_snapshot")
    graph.add_edge("persist_decision_snapshot", END)

    return graph.compile()
