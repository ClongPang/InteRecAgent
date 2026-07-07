from __future__ import annotations

from backend.app.schemas import ClarificationPayload, IntentState


class ClarificationPolicy:
    def decide(self, intent: IntentState, message: str) -> tuple[bool, ClarificationPayload | None, str]:
        if "category" in intent.uncertainty_fields:
            return (
                True,
                ClarificationPayload(
                    question="What kind of product should I focus on for work?",
                    options=["Headphones", "Mouse", "Desk accessory"],
                ),
                "missing category",
            )
        if not intent.budget and "cheap" in message.lower():
            return (
                True,
                ClarificationPayload(
                    question="What budget range should I use?",
                    options=["Under $50", "Under $100", "No strict budget"],
                ),
                "budget implied but missing",
            )
        return False, None, "enough information to recommend"
