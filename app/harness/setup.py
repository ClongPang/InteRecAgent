from __future__ import annotations

from app.harness.hooks.assertion_handler import handle_failed_assertions
from app.harness.hooks.breaker import record_breaker_result
from app.harness.hooks.content_filter import filter_tool_output
from app.harness.hooks.drift_detector import detect_drift, reset_drift_state
from app.harness.hooks.loop_detector import detect_loop
from app.harness.hooks.output_guard import audit_final_output, writeback_preferences
from app.harness.hooks.phase_check import check_phase_permission, check_user_tier_permission
from app.harness.hooks.phase_transition import (
    check_phase_rollback,
    try_phase_transition,
)
from app.harness.hooks.schema_validate import validate_tool_args
from app.harness.hooks.semantic_check import check_semantic_alignment
from app.harness.hooks.sequencing import (
    check_sequencing,
    record_tool_call,
    reset_sequence_state,
)
from app.harness.hooks.step_validator import check_schema
from app.harness.hooks.token_budget import check_budget, init_budget, inject_budget_hint
from app.harness.hooks.tool_whitelist import check_tool_whitelist
from app.harness.hooks.truncate import truncate_tool_result
from app.harness.middleware import harness
from app.harness.phase_machine import reset_phase_state


_configured = False


def setup_harness() -> None:
    """Register the default Hook Pipeline once."""
    global _configured
    if _configured:
        return

    harness.register("on_session_start", "init_budget", init_budget, priority=10)
    harness.register("on_session_start", "sequence_reset", reset_sequence_state, priority=20)
    harness.register("on_session_start", "drift_reset", reset_drift_state, priority=30)
    harness.register("on_session_start", "phase_reset", reset_phase_state, priority=40)

    harness.register("pre_think", "budget_hint", inject_budget_hint, priority=10)

    harness.register("pre_tool_call", "tool_whitelist", check_tool_whitelist, priority=10)
    harness.register("pre_tool_call", "phase_check", check_phase_permission, priority=20)
    harness.register("pre_tool_call", "user_tier_check", check_user_tier_permission, priority=22)
    harness.register("pre_tool_call", "sequencing_assertion", check_sequencing, priority=25)
    harness.register("pre_tool_call", "schema_validate", validate_tool_args, priority=30)

    harness.register("post_tool_call", "content_filter", filter_tool_output, priority=10)
    harness.register("post_tool_call", "truncate", truncate_tool_result, priority=20)
    harness.register("post_tool_call", "breaker_record", record_breaker_result, priority=30)
    harness.register("post_tool_call", "schema_assertion", check_schema, priority=40)
    harness.register("post_tool_call", "semantic_assertion", check_semantic_alignment, priority=45)
    harness.register("post_tool_call", "sequencing_record", record_tool_call, priority=50)

    harness.register("post_reflect", "loop_detector", detect_loop, priority=10)
    harness.register("post_reflect", "assertion_handler", handle_failed_assertions, priority=15)
    harness.register("post_reflect", "drift_detector", detect_drift, priority=20)
    harness.register("post_reflect", "budget_check", check_budget, priority=30)
    harness.register("post_reflect", "phase_transition", try_phase_transition, priority=40)
    harness.register("post_reflect", "phase_rollback", check_phase_rollback, priority=41)

    harness.register("on_session_end", "output_guard", audit_final_output, priority=10)
    harness.register("on_session_end", "store_writeback", writeback_preferences, priority=20)

    _configured = True
