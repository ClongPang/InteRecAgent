# app/observability/langfuse_client.py
import os
import re
from functools import lru_cache
from typing import Any

from dotenv import load_dotenv


load_dotenv()


class NoopSpan:
    def update(self, **_: Any) -> None:
        return None

    def end(self, **_: Any) -> None:
        return None


class NoopTrace:
    trace_id: str | None = None

    def span(self, **_: Any) -> NoopSpan:
        return NoopSpan()

    def event(self, **_: Any) -> None:
        return None

    def update(self, **_: Any) -> None:
        return None


class LangfuseSpanAdapter:
    def __init__(self, observation: Any) -> None:
        self._observation = observation

    def end(self, output: Any | None = None, metadata: Any | None = None) -> None:
        if output is not None or metadata is not None:
            self._observation.update(output=output, metadata=metadata)
        self._observation.end()


class LangfuseTraceAdapter:
    def __init__(
        self,
        client: Any,
        trace_id: str,
        name: str,
        user_id: str | None,
        input: dict[str, Any],
        metadata: dict[str, Any],
    ) -> None:
        self.client = client
        self.trace_id = trace_id
        self._root = client.start_observation(
            trace_context={"trace_id": trace_id},
            name=name,
            as_type="agent",
            input=input,
            metadata={**metadata, "user_id": user_id},
        )

    def span(
        self,
        name: str,
        input: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> LangfuseSpanAdapter:
        observation = self.client.start_observation(
            trace_context={"trace_id": self.trace_id},
            name=name,
            as_type="tool",
            input=input,
            metadata=metadata,
        )
        return LangfuseSpanAdapter(observation)

    def update(
        self,
        output: dict[str, Any] | None = None,
        level: str | None = None,
    ) -> None:
        self._root.update(output=output, level=level)

    def event(
        self,
        name: str,
        input: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.client.start_observation(
            trace_context={"trace_id": self.trace_id},
            name=name,
            as_type="event",
            input=input,
            metadata=metadata,
        ).end()

    def end(self) -> None:
        self._root.end()


def langfuse_configured() -> bool:
    return bool(
        os.environ.get("LANGFUSE_PUBLIC_KEY")
        and os.environ.get("LANGFUSE_SECRET_KEY")
    )


@lru_cache(maxsize=1)
def get_langfuse_client() -> Any | None:
    if not langfuse_configured():
        return None

    from langfuse import Langfuse

    return Langfuse(
        public_key=os.environ.get("LANGFUSE_PUBLIC_KEY"),
        secret_key=os.environ.get("LANGFUSE_SECRET_KEY"),
        host=os.environ.get("LANGFUSE_HOST"),
    )


def create_trace(
    name: str,
    thread_id: str,
    user_id: str | None,
    input: dict[str, Any],
    metadata: dict[str, Any],
) -> LangfuseTraceAdapter | NoopTrace:
    client = get_langfuse_client()
    if client is None:
        return NoopTrace()

    from langfuse import Langfuse

    trace_id = normalize_trace_id(thread_id)
    return LangfuseTraceAdapter(
        client=client,
        trace_id=trace_id,
        name=name,
        user_id=user_id,
        input=input,
        metadata={**metadata, "thread_id": thread_id},
    )


def flush_langfuse() -> None:
    client = get_langfuse_client()
    if client is not None:
        client.flush()


def score_trace(
    trace_id: str,
    name: str,
    value: float,
    comment: str | None = None,
) -> None:
    client = get_langfuse_client()
    if client is None:
        return

    from langfuse import Langfuse

    client.create_score(
        trace_id=normalize_trace_id(trace_id),
        name=name,
        value=value,
        comment=comment,
    )


def normalize_trace_id(seed_or_trace_id: str) -> str:
    if re.fullmatch(r"[0-9a-f]{32}", seed_or_trace_id):
        return seed_or_trace_id

    from langfuse import Langfuse

    return Langfuse.create_trace_id(seed=seed_or_trace_id)
