from __future__ import annotations

from dataclasses import dataclass

from backend.app.schemas import TaskType


@dataclass(frozen=True)
class TaskRoute:
    task_type: TaskType
    confidence: float
    rationale: str


UNSUPPORTED_TERMS = ("buy", "checkout", "shipping", "in stock", "stock today", "payment")
NEGATIVE_TERMS = ("too expensive", "avoid", "don't want", "do not want", "not this brand")
ALTERNATIVE_TERMS = ("alternative", "similar", "cheaper", "another one")
BUNDLE_TERMS = ("bundle", "starter kit", "set of")


class TaskRouter:
    def route(self, message: str, feedback_type: str | None = None) -> TaskRoute:
        lower_message = message.lower()
        if any(term in lower_message for term in UNSUPPORTED_TERMS):
            return TaskRoute("unsupported", 0.98, "message asks for live commerce capability")
        if feedback_type or any(term in lower_message for term in NEGATIVE_TERMS):
            return TaskRoute("negative_feedback", 0.9, "message updates or rejects prior recommendation")
        if any(term in lower_message for term in ALTERNATIVE_TERMS):
            return TaskRoute("alternative_recommendation", 0.82, "message requests alternatives")
        if "compare" in lower_message:
            return TaskRoute("comparison", 0.78, "message asks to compare candidates")
        if "gift" in lower_message:
            return TaskRoute("gift_recommendation", 0.72, "message asks for gift recommendation")
        if any(term in lower_message for term in BUNDLE_TERMS):
            return TaskRoute("bundle_recommendation", 0.72, "message asks for a bundle")
        return TaskRoute("single_item_recommendation", 0.86, "default catalog recommendation task")
