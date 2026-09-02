# ADR-0002：使用 Langfuse v5 作为 pi-agent 可观测性主视图

- 状态：Accepted。Trace 边界、Provider 层级与导出生命周期由 ADR-0010 修订。根 I/O 与决策身份由 `interec-agent-trace-v4` / `interec-turn-decision-v5` 修订。
- 日期：2026-08-26

## 背景

项目已有 OpenTelemetry spans 和业务 metrics，但缺少 Agent/generation/tool 语义、token/cost 视图和按 Conversation Turn 下钻的 LLM 工程界面。PostgreSQL 仍是业务事实源；观测不能取代它，也不能默认复制未脱敏的密钥或隐藏思维链。

## 决策

采用锁定的 `@langfuse/otel@5.10.1` 与 `@langfuse/tracing@5.10.1`：

- Langfuse 承载 Agent/LLM trace、generation token/cost、tool 层级。评测闭环的源是本地 code score，不是 Langfuse 产品里的 dataset / LLM-as-judge。
- PostgreSQL 保存 durable 状态、审计以及有 Observation 来源证明的 `trace_id`。
- 使用 Langfuse v5 observations-first 模型和 OTel 原生 ingestion。
- 投影分成三通道：`view`（根 I/O，始终可扫）、`decision`（闭集 why + 目录身份）、`content`（正文，可关）。隐藏思维链始终不采集。
- exporter 不可用不得改变业务 Turn 终态。发布证据是 `observability:smoke` 的真实 Langfuse 回读。

## 现行边界

- Conversation 用 Session 聚合。enqueue 与 attempt 用 `turn-enqueue` / `turn-attempt` 标签区分。
- enqueue 与每个 Worker attempt 是独立真实根 Trace。attempt 用 `causedBy*` metadata 和 OTel span link 指向 enqueue，不用已结束的 API span 当父节点。
- 根 input/output 是 OpenAI 消息对。正文关闭时用户侧是 `[CONTENT_NOT_CAPTURED]`，助手侧是 `outcome | route | lifecycle | catalogIdentity`。
- 决策通道带 `targetRef` / `modelKey` / `canonicalModel`（目录码，不是用户原话）。
- 机器合同是 `spec/observability/agent-trace-contract.json`。
- 仓库门禁是 `npm run observability:check`。真实摄取回读是 `npm run observability:smoke`，不能被仓库静态检查代替。

## 不选择的方案

仅用通用 APM、仅用 Pi 内部 telemetry、或自建完整 LLM trace 表。也不把 enqueue 伪造成 attempt 的父节点，也不把用户原话写进始终采集的决策通道。
