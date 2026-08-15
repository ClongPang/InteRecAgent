from app.agent.prompts import get_system_prompt


def build_system_prompt(long_term_preferences: str = "") -> str:
    """Compatibility wrapper for the project map's system_prompt.py module."""
    return get_system_prompt(long_term_preferences)
