"""对话服务兼容入口。实现已拆到 nlu / route / thread / next_move。"""
from __future__ import annotations

from .next_move import next_moves_for
from .nlu import (
    apply_stance_budget,
    build_turn_context,
    classify_turn,
    detect_ask_topic,
    detect_referent_hint,
    preview_merged_constraints,
    resolve_referent_ids,
    reuse_key_matches,
    search_reuse_key,
    snapshot_ids_for_ranks,
    summarize_constraint_change,
)
from .parse_intent import parse_intent
from .route import phase_for_route, plan_route, preview_turn, stage_for_phase
from .thread import project_thread

__all__ = [
    "apply_stance_budget",
    "build_turn_context",
    "classify_turn",
    "detect_ask_topic",
    "detect_referent_hint",
    "next_moves_for",
    "parse_intent",
    "phase_for_route",
    "plan_route",
    "preview_merged_constraints",
    "preview_turn",
    "project_thread",
    "resolve_referent_ids",
    "reuse_key_matches",
    "search_reuse_key",
    "snapshot_ids_for_ranks",
    "stage_for_phase",
    "summarize_constraint_change",
]
