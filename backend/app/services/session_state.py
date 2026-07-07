from __future__ import annotations

from backend.app.schemas import ChatRequest, ChatTurnResponse, IntentState, SessionState


class SessionStateManager:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._recommendation_history: dict[str, list[str]] = {}
        self._feedback_history: dict[str, list[dict[str, str | None]]] = {}

    def get(self, session_id: str) -> SessionState:
        return self._sessions.setdefault(session_id, SessionState(session_id=session_id))

    def record_turn(self, request: ChatRequest, response: ChatTurnResponse) -> SessionState:
        session = self.get(response.session_id)
        session.messages.append({"role": "user", "content": request.feedback_text or request.message})
        session.messages.append({"role": "assistant", "content": response.message})
        session.current_intent = response.intent_state
        if response.products:
            self._recommendation_history.setdefault(response.session_id, []).append(response.turn_id)
        if request.feedback_text or request.feedback_type:
            self._feedback_history.setdefault(response.session_id, []).append(
                {
                    "turn_id": response.turn_id,
                    "feedback_text": request.feedback_text,
                    "feedback_type": request.feedback_type,
                    "anchor_product_id": request.anchor_product_id,
                }
            )
        return session

    def current_intent(self, session_id: str) -> IntentState:
        return self.get(session_id).current_intent

    def recommendation_turns(self, session_id: str) -> list[str]:
        return list(self._recommendation_history.get(session_id, []))

    def feedback_events(self, session_id: str) -> list[dict[str, str | None]]:
        return list(self._feedback_history.get(session_id, []))
