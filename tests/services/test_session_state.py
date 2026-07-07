from backend.app.schemas import ChatRequest
from backend.app.services.chat_orchestrator import ChatOrchestrator
from backend.app.services.session_state import SessionStateManager


def test_session_state_records_messages_intent_and_history():
    manager = SessionStateManager()
    request = ChatRequest(
        session_id="sess_state",
        message="Recommend wireless headphones under 100 dollars.",
    )
    response = ChatOrchestrator().run(request)

    session = manager.record_turn(request, response)

    assert session.session_id == "sess_state"
    assert session.messages[0]["role"] == "user"
    assert session.messages[1]["role"] == "assistant"
    assert session.current_intent.category == "wireless headphones"
    assert manager.recommendation_turns("sess_state") == [response.turn_id]


def test_session_state_records_feedback_events():
    manager = SessionStateManager()
    request = ChatRequest(
        session_id="sess_state",
        message="Too expensive",
        feedback_text="Too expensive",
        feedback_type="price",
        anchor_product_id="prod_headphones_001",
    )
    response = ChatOrchestrator().run(request)

    manager.record_turn(request, response)

    assert manager.feedback_events("sess_state") == [
        {
            "turn_id": response.turn_id,
            "feedback_text": "Too expensive",
            "feedback_type": "price",
            "anchor_product_id": "prod_headphones_001",
        }
    ]
