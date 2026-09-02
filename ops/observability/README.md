# Conversation observability

可观测性主视图是 Langfuse agent trace。

合同是 `spec/observability/agent-trace-contract.json`。根 I/O 是 `view`（OpenAI 消息对）。决策和目录身份在 `execute-turn-attempt` metadata。PostgreSQL 是业务事实源；导出失败不得改变 Turn 终态。

按会话看用 Session。enqueue 与 attempt 是两条根，标签是 `turn-enqueue` / `turn-attempt`。

进程内 OpenTelemetry 计数清单在 `spec/observability/metrics-contract.json`。

门禁：`npm run observability:check`。发布证据：`INTEREC_LANGFUSE_SMOKE_CONFIRM=authorized-langfuse-readback npm run observability:smoke`。
