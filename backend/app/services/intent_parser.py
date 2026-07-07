from __future__ import annotations

import re

from backend.app.schemas import Budget, Constraint, IntentState
from backend.app.services.task_router import TaskRoute


class IntentParser:
    def parse(self, message: str, route: TaskRoute, previous: IntentState | None = None) -> IntentState:
        lower_message = message.lower()
        intent = previous.model_copy(deep=True) if previous else IntentState()
        intent.task_type = route.task_type

        if "headphone" in lower_message:
            intent.category = "wireless headphones"
        elif "mouse" in lower_message:
            intent.category = "wireless mouse"
        elif not intent.category and "something for work" not in lower_message:
            intent.category = "catalog item"

        if "commut" in lower_message:
            intent.goal = "commuting"
            intent.scenario = "daily commute"
        elif "office" in lower_message or "work" in lower_message:
            intent.goal = "work"
            intent.scenario = "office"

        budget_match = re.search(r"(?:under|below|less than|\$)\s*\$?(\d+)", lower_message)
        if budget_match:
            budget_value = float(budget_match.group(1))
            intent.budget = Budget(max=budget_value, currency="USD")
            intent.hard_constraints = [
                constraint
                for constraint in intent.hard_constraints
                if constraint.field != "price"
            ]
            intent.hard_constraints.append(Constraint(field="price", op="<=", value=budget_value))

        priorities = []
        for keyword in ("comfort", "comfortable", "battery", "portable", "quiet"):
            if keyword in lower_message:
                priorities.append("comfort" if keyword == "comfortable" else keyword)
        if priorities:
            intent.priority_order = list(dict.fromkeys(priorities))

        soft_preferences = set(intent.soft_preferences)
        if "compact" in lower_message or "portable" in lower_message:
            soft_preferences.add("portable")
        if "comfortable" in lower_message or "comfort" in lower_message:
            soft_preferences.add("comfortable")
        if "quiet" in lower_message:
            soft_preferences.add("quiet click")
        intent.soft_preferences = sorted(soft_preferences)

        uncertainty_fields = set(intent.uncertainty_fields)
        if not intent.category:
            uncertainty_fields.add("category")
        else:
            uncertainty_fields.discard("category")
        intent.uncertainty_fields = sorted(uncertainty_fields)
        return intent
