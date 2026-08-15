from __future__ import annotations

from app.api.context import UserTier, get_user_tier
from app.harness.phase_machine import phase_machine


USER_TIER_RESTRICTIONS: dict[UserTier, set[str]] = {
    "free": {"dispatch_tool"},
    "standard": set(),
    "premium": set(),
}


def get_user_filtered_tools(
    user_tier: UserTier | None = None,
    thread_id: str | None = None,
) -> set[str]:
    """Apply user-tier restrictions on top of the current phase tool set."""
    tier = user_tier or get_user_tier()
    phase_allowed = phase_machine.get_allowed_tools(thread_id)
    restricted = USER_TIER_RESTRICTIONS.get(tier, set())
    return phase_allowed - restricted


def is_tool_allowed_for_user(
    tool_name: str,
    user_tier: UserTier | None = None,
) -> bool:
    tier = user_tier or get_user_tier()
    return tool_name not in USER_TIER_RESTRICTIONS.get(tier, set())


def get_user_restricted_tools(user_tier: UserTier | None = None) -> set[str]:
    tier = user_tier or get_user_tier()
    return set(USER_TIER_RESTRICTIONS.get(tier, set()))
