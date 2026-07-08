from __future__ import annotations

from pathlib import Path

from backend.app.schemas import ChatTurnResponse, InternalTrace


def build_trace_from_response(request_message: str, response: ChatTurnResponse) -> InternalTrace:
    return InternalTrace(
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
        filtering={
            "input_count": response.trace_summary.retrieved_count,
            "output_count": response.trace_summary.filtered_count,
            "hard_constraint_violations": [
                {
                    "product_id": product.product_id,
                    "checks": [
                        check.model_dump()
                        for check in product.constraint_checks
                        if check.status == "violated"
                    ],
                }
                for product in response.products
                if any(check.status == "violated" for check in product.constraint_checks)
            ],
            "unknown_constraints": [
                {
                    "product_id": product.product_id,
                    "checks": [
                        check.model_dump()
                        for check in product.constraint_checks
                        if check.status == "unknown"
                    ],
                }
                for product in response.products
                if any(check.status == "unknown" for check in product.constraint_checks)
            ],
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
            "claims": [
                claim.model_dump()
                for product in response.products
                for claim in product.claim_evidence
            ],
        },
        latency_ms={"total": 1.0},
    )


class InMemoryTraceStore:
    def __init__(self) -> None:
        self._traces: dict[str, InternalTrace] = {}

    def write_from_response(self, request_message: str, response: ChatTurnResponse) -> InternalTrace:
        trace = build_trace_from_response(request_message, response)
        self._traces[trace.turn_id] = trace
        return trace

    def read(self, turn_id: str) -> InternalTrace | None:
        return self._traces.get(turn_id)


class JsonlTraceStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def write_from_response(self, request_message: str, response: ChatTurnResponse) -> InternalTrace:
        trace = build_trace_from_response(request_message, response)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as trace_file:
            trace_file.write(trace.model_dump_json() + "\n")
        return trace

    def read(self, turn_id: str) -> InternalTrace | None:
        if not self.path.exists():
            return None
        with self.path.open("r", encoding="utf-8") as trace_file:
            for line in trace_file:
                if not line.strip():
                    continue
                trace = InternalTrace.model_validate_json(line)
                if trace.turn_id == turn_id:
                    return trace
        return None


trace_store = InMemoryTraceStore()
