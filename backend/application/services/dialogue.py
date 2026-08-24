"""对话服务兼容入口。实现已拆到 nlu / route / thread / next_move。"""
from __future__ import annotations

from .next_move import next_moves_for
from .nlu import (
    apply_stance_budget,
    build_turn_context,
    classify_turn,
    detect_ask_topic,
    detect_referent_hint,
    ground_dialogue_act,
    preview_merged_constraints,
    resolve_referent_ids,
    reuse_key_matches,
    search_reuse_key,
    snapshot_ids_for_ranks,
    summarize_constraint_change,
)
from .parse_intent import parse_intent
from .policy import apply_act_effects, sanitize_constraints
from .route import (
    escalate_empty_merchant_filter,
    phase_for_route,
    plan_route,
    preview_turn,
    stage_for_phase,
)
from .thread import project_thread
from .uncertainty import moves_for_reply, select_probe

__all__ = [
    "apply_act_effects",
    "apply_stance_budget",
    "build_turn_context",
    "classify_turn",
    "ground_dialogue_act",
    "detect_ask_topic",
    "escalate_empty_merchant_filter",
    "detect_referent_hint",
    "moves_for_reply",
    "next_moves_for",
    "parse_intent",
    "select_probe",
    "phase_for_route",
    "plan_route",
    "preview_merged_constraints",
    "preview_turn",
    "project_thread",
    "resolve_referent_ids",
    "reuse_key_matches",
    "sanitize_constraints",
    "search_reuse_key",
    "snapshot_ids_for_ranks",
    "stage_for_phase",
    "summarize_constraint_change",
]
