from backend.app.services.task_router import TaskRouter


def test_task_router_classifies_unsupported_live_commerce():
    route = TaskRouter().route("Can you check stock today and buy it?")

    assert route.task_type == "unsupported"
    assert route.confidence > 0.9


def test_task_router_classifies_feedback_and_alternatives():
    router = TaskRouter()

    assert router.route("Too expensive").task_type == "negative_feedback"
    assert router.route("Show me a cheaper alternative").task_type == "alternative_recommendation"
