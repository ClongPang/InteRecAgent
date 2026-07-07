from __future__ import annotations

from backend.app.schemas import ChatTurnResponse, InternalTrace


class InMemoryTraceStore:
    def __init__(self) -> None:
        self._traces: dict[str, InternalTrace] = {}

    def write_from_response(self, request_message: str, response: ChatTurnResponse) -> InternalTrace:
        trace = InternalTrace(
            turn_id=response.turn_id,
            session_id=response.session_id,
            input=request_message,
            task_route={
                "task_type": response.task_type,
                "confidence": 1.0 if response.status != "error" else 0.0,
                "rationale": "mock deterministic route",
            },
            intent_after=response.intent_state.model_dump(),
            feedback_update=response.trace_summary.feedback_update or {},
            clarification=response.trace_summary.clarification_decision,
            retrieval={
                "top_k": response.trace_summary.retrieved_count,
                "retrieved_items": [product.product_id for product in response.products],
            },
            constraint_checks=[
                check.model_dump()
                for product in response.products
                for check in product.constraint_checks
            ],
            ranking={
                "ranked_items": [product.product_id for product in response.products],
                "score_breakdowns": {
                    product.product_id: product.score_breakdown for product in response.products
                },
            },
            llm_rerank=response.trace_summary.rerank_summary,
            final_validation={"passed": True, "violations": []},
            response={
                "message": response.message,
                "product_ids": [product.product_id for product in response.products],
                "claims": [],
            },
            latency_ms={"total": 1.0},
        )
        self._traces[trace.turn_id] = trace
        return trace

    def read(self, turn_id: str) -> InternalTrace | None:
        return self._traces.get(turn_id)


trace_store = InMemoryTraceStore()
