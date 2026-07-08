from backend.app.services.llm_adapter import LLMAdapter, LLMAdapterError
from backend.app.services.llm_intent_parser import LLMIntentParseResult, LLMIntentParser
from backend.app.services.task_router import TaskRouter


class IntentAdapter:
    mode = "mock"

    def generate_json(self, _prompt, schema):
        assert schema is LLMIntentParseResult
        return LLMIntentParseResult(
            category="wireless mouse",
            goal="office work",
            scenario="desk setup",
            budget_max=50,
            priority_order=["quiet", "portable"],
            soft_preferences=["quiet click"],
        )


class BrokenAdapter:
    mode = "mock"

    def generate_json(self, _prompt, _schema):
        raise LLMAdapterError("LLM output failed schema validation")


def test_llm_intent_parser_merges_valid_slots_with_baseline_intent():
    route = TaskRouter().route("Recommend something quiet for office")

    intent, summary = LLMIntentParser(adapter=IntentAdapter()).parse(
        "Recommend something quiet for office",
        route,
    )

    assert intent.category == "wireless mouse"
    assert intent.goal == "office work"
    assert intent.scenario == "desk setup"
    assert intent.budget is not None
    assert intent.budget.max == 50
    assert "price" in [constraint.field for constraint in intent.hard_constraints]
    assert intent.priority_order == ["quiet", "portable"]
    assert "quiet click" in intent.soft_preferences
    assert summary["used_fallback"] is False


def test_llm_intent_parser_falls_back_to_baseline_on_invalid_schema():
    route = TaskRouter().route("Recommend wireless headphones under 100 dollars")

    intent, summary = LLMIntentParser(adapter=BrokenAdapter()).parse(
        "Recommend wireless headphones under 100 dollars",
        route,
    )

    assert intent.category == "wireless headphones"
    assert intent.budget is not None
    assert intent.budget.max == 100
    assert summary["used_fallback"] is True
    assert summary["error"] == "LLM output failed schema validation"


def test_llm_intent_parser_default_mock_adapter_falls_back_without_dirty_state():
    route = TaskRouter().route("I need something for work")

    intent, summary = LLMIntentParser(adapter=LLMAdapter(mode="mock")).parse(
        "I need something for work",
        route,
    )

    assert intent.category == ""
    assert "category" in intent.uncertainty_fields
    assert summary["used_fallback"] is True
