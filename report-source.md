# Agent Trace observability refactor research source

- Audience: RetailPriceAgent maintainers
- Date: 2026-09-02
- Scope: trace identity, asynchronous boundaries, Agent tool causality, model-boundary manifests, Langfuse rendering, privacy and operational detection
- Assumption: PostgreSQL remains the durable business source of truth; Langfuse/OTel are diagnostic projections and must not change Turn outcomes

## Direct answer

The prior design conflated an API enqueue with a Worker execution, and its causality guardrail proved only that tool lifecycle events existed. The implemented target uses one real Trace per attempt, correlation instead of synthetic parenting across the asynchronous boundary, and an explicit ledger that proves model request, host result, event result and next-generation consumption agree.

The detailed code evidence, decisions, migration plan and verification record are in `docs/agent-trace-observability-refactor.md`.

## Claim-to-source ledger

| Claim | Primary source | Access notes |
| --- | --- | --- |
| Asynchronous producer/consumer causality should use propagated creation context and, by default, Span Links rather than assuming a single parent tree. | OpenTelemetry, “Semantic conventions for messaging spans”, current development specification, https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/ | Read 2026-09-02; trace-structure and consumer-span sections. |
| GenAI tool execution has a first-class operation and `gen_ai.tool.call.id`; tool arguments/results are part of that operation’s optional semantic data. | OpenTelemetry GenAI Semantic Conventions, `gen-ai-agent-spans.md` and `model/gen-ai/spans.yaml`, https://github.com/open-telemetry/semantic-conventions-genai | Shallow-cloned and inspected 2026-09-02; conventions are marked Development. |
| A Langfuse Trace should be a self-contained unit such as one chatbot turn or one agent run; sessions group multiple traces. | Langfuse, “What does a good trace look like?”, https://langfuse.com/docs/observability/best-practices | Read as official Markdown 2026-09-02. |
| Langfuse agent loops should expose each model call as a Generation interleaved with Tool observations; stable names and meaningful root I/O are evaluator/dashboard APIs. | Langfuse, “What does a good trace look like?”, https://langfuse.com/docs/observability/best-practices | Read as official Markdown 2026-09-02. |
| Standard assistant `tool_calls` and tool `tool_call_id` message shapes are required for readable Tool cards. | Langfuse, “What does a good trace look like?”, https://langfuse.com/docs/observability/best-practices | Read as official Markdown 2026-09-02. |
| LangSmith models one operation as a Trace, one unit as a Run, and a multi-turn session as a Thread; trajectories are ordered message projections. | LangChain, “LangSmith observability concepts”, https://docs.langchain.com/langsmith/observability-concepts | Read as official Markdown 2026-09-02. |
| OpenAI Agents traces include model turns, generations, function calls, guardrails and handoffs, while `group_id` links conversation-related traces. | OpenAI, “Agents SDK Tracing”, https://openai.github.io/openai-agents-python/tracing/ | Read from the official GitHub source `docs/tracing.md` on 2026-09-02. |
| Background exporters require lifecycle flushing/health evidence; repository instrumentation alone does not prove backend ingestion. | OpenAI Agents tracing and Langfuse observability data model, https://openai.github.io/openai-agents-python/tracing/ and https://langfuse.com/docs/observability/data-model | Both official documents describe background batching and explicit flush needs for short-lived work. |
| Langfuse models an external API call as a TOOL observation, distinct from a host orchestration span. | Langfuse, “Observation Types”, https://langfuse.com/docs/observability/features/observation-types | Read 2026-09-02; the official example identifies an external weather API call as a tool. |
| Buffered JS/OTel observations may be lost unless short-lived/exit paths explicitly force-flush or shutdown and await completion. | Langfuse, “Event Queuing/Batching”, https://langfuse.com/docs/observability/features/queuing-batching | Read 2026-09-02; includes `LangfuseSpanProcessor.forceFlush()` and shutdown guidance. |
| HTTP client spans should expose received status or a low-cardinality `error.type` for network/timeout/HTTP failure analysis. | OpenTelemetry, “Semantic conventions for HTTP spans”, https://opentelemetry.io/docs/specs/semconv/http/http-spans/ | Read 2026-09-02; stable HTTP client convention and error recording sections. |

## Limitations and disagreements

- OpenTelemetry GenAI Agent conventions are still marked Development, so the project freezes its own v3 contract instead of treating current attribute names as stable forever.
- Langfuse’s JS observation helper used here does not expose OTel Span Links. The implementation therefore creates truthful separate roots and records durable `causedByTraceId/causedByObservationId`; adding native links remains appropriate if the SDK exposes them later.
- No production Langfuse credentials were used in this refactor. Real Langfuse readback remains release evidence, not a repository claim.

## Research stop rationale

Research stopped after four independent mature designs converged on the same boundary model: a self-contained run/turn Trace, a session/thread/group for conversation correlation, and first-class interleaved model/tool observations. Further sources would not resolve the only project-specific decisions—queue-attempt identity persistence, result-consumption invariants, and the local privacy gate—which had to be decided from this repository's code and failure modes.
