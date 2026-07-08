from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from backend.app.schemas import Budget, Constraint, IntentState
from backend.app.services.intent_parser import IntentParser
from backend.app.services.llm_adapter import LLMAdapter, LLMAdapterError
from backend.app.services.task_router import TaskRoute


class LLMIntentParseResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str | None = None
    goal: str | None = None
    scenario: str | None = None
    budget_max: float | None = Field(default=None, ge=0)
    currency: str = "USD"
    priority_order: list[str] = Field(default_factory=list)
    soft_preferences: list[str] = Field(default_factory=list)
    uncertainty_fields: list[str] = Field(default_factory=list)


class LLMIntentParser:
    def __init__(
        self,
        adapter: LLMAdapter | None = None,
        baseline: IntentParser | None = None,
    ) -> None:
        self.adapter = adapter or LLMAdapter(mode="mock")
        self.baseline = baseline or IntentParser()

    def parse(
        self,
        message: str,
        route: TaskRoute,
        previous: IntentState | None = None,
    ) -> tuple[IntentState, dict[str, object]]:
        baseline_intent = self.baseline.parse(message, route, previous)
        prompt = (
            "Extract shopping intent slots as JSON. "
            f"Task type: {route.task_type}. User message: {message}"
        )
        try:
            parsed = self.adapter.generate_json(prompt, LLMIntentParseResult)
        except LLMAdapterError as exc:
            return baseline_intent, {
                "mode": getattr(self.adapter, "mode", "unknown"),
                "used_fallback": True,
                "error": str(exc),
            }

        intent = baseline_intent.model_copy(deep=True)
        if parsed.category:
            intent.category = parsed.category
        if parsed.goal:
            intent.goal = parsed.goal
        if parsed.scenario:
            intent.scenario = parsed.scenario
        if parsed.budget_max is not None:
            intent.budget = Budget(max=parsed.budget_max, currency=parsed.currency or "USD")
            intent.hard_constraints = [
                constraint
                for constraint in intent.hard_constraints
                if constraint.field != "price"
            ]
            intent.hard_constraints.append(
                Constraint(field="price", op="<=", value=parsed.budget_max)
            )
        if parsed.priority_order:
            intent.priority_order = list(dict.fromkeys(parsed.priority_order))
        if parsed.soft_preferences:
            intent.soft_preferences = sorted(set(intent.soft_preferences) | set(parsed.soft_preferences))
        intent.uncertainty_fields = sorted(set(parsed.uncertainty_fields))
        if intent.category:
            intent.uncertainty_fields = [
                field for field in intent.uncertainty_fields if field != "category"
            ]
        return intent, {
            "mode": getattr(self.adapter, "mode", "unknown"),
            "used_fallback": False,
            "llm_slots": parsed.model_dump(),
        }
