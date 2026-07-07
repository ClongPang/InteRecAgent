from backend.app.services.intent_parser import IntentParser
from backend.app.services.task_router import TaskRouter


def test_intent_parser_extracts_category_budget_and_preferences():
    route = TaskRouter().route("Recommend wireless headphones under 100 dollars for commuting with comfort")
    intent = IntentParser().parse(
        "Recommend wireless headphones under 100 dollars for commuting with comfort",
        route,
    )

    assert intent.category == "wireless headphones"
    assert intent.budget is not None
    assert intent.budget.max == 100
    assert "price" in [constraint.field for constraint in intent.hard_constraints]
    assert "comfort" in intent.priority_order


def test_intent_parser_marks_missing_category_as_uncertain():
    route = TaskRouter().route("I need something for work")
    intent = IntentParser().parse("I need something for work", route)

    assert "category" in intent.uncertainty_fields
