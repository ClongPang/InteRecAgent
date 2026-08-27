# ADR-0002：使用 Langfuse v5 作为 pi-agent 可观测性主视图

- 状态：Accepted
- 日期：2026-08-26

## 背景

项目已有 OpenTelemetry spans 和业务 metrics，但缺少 Agent/generation/tool 语义、token/cost 视图、评估入口和可直接按 Conversation Turn 下钻的 LLM 工程界面。仅把所有事件写日志或发送到通用 APM，难以高效诊断模型漏调正式工具、错误工具路径和商品资格误判。

PostgreSQL durable ledger 已经是业务事实源，新的观测方案不能取代或弱化它，也不能默认复制用户 prompt、工具载荷和 Provider 原文。

## 决策

采用精确锁定的 `@langfuse/otel@5.10.1` 与 `@langfuse/tracing@5.10.1`：

- Langfuse 承载 Agent/LLM trace、generation token/cost、tool 层级和后续 eval score。
- OpenTelemetry metrics 继续发送到独立 OTLP metrics 后端。
- PostgreSQL 保存 durable 状态、审计记录和 `trace_id`，仍是唯一业务事实源。
- 使用 Langfuse v5 observations-first 模型和 OTel 原生 ingestion，不接入 legacy ingestion API。
- 默认 metadata-only；内容采集必须显式启用并经过客户端遮蔽。
- trace exporter 不可用不得改变业务 Turn 的执行或终态，但生产审批要求 exporter、Dashboard 和告警有独立健康证据。

## 不选择的方案

### 仅使用通用 OTel Collector/APM

保留标准化和基础设施监控能力，但缺少直接可用的 generation、token/cost、prompt/eval 工作流。仍可作为 metrics/log 后端，不作为 Agent 主视图。

### 仅使用 Pi 内部 telemetry

与 Agent 事件贴近，但不能覆盖 API、durable worker、PostgreSQL correlation 和外部 Provider，也没有满足本系统需要的生产 exporter 与运营视图。

### 自建 LLM trace 表与 Dashboard

控制力强，但会重复建设 ingestion、聚合、成本、评估和 UI，并扩大维护与隐私风险。PostgreSQL 只保留必要审计和关联字段，不复制完整 Langfuse observation 模型。

## 结果

正面：

- Conversation、Turn、Pi Agent、generation、tool、Provider 形成一棵可检索 trace。
- token、cost、evidence block、研究失败和错误可按模型、发布版本和环境分析。
- `turn_id`/`trace_id` 双向关联，事故定位不依赖模糊时间窗口。
- 后续 100 条 gold 与 Shadow 可以直接挂接 observation 级 score。

代价与风险：

- 新增 Langfuse 服务/Cloud 依赖和项目密钥治理。
- SDK/OTel 语义升级可能改变字段映射，因此必须精确锁版并保留 exporter 契约测试。
- Dashboard/告警不能只靠代码仓库证明，必须在目标 Langfuse 项目完成真实 smoke 与运营验收。
- Langfuse 不能接收本项目自定义 OTel metrics，仍需独立 metrics 后端。

## 验证

- 自动化测试包含 Langfuse 配置、遮蔽和 exporter trace 树契约；具体数量不固化在 ADR 中。
- PostgreSQL 集成测试验证 trace id 持久化与导出 trace 一致。
- `observability:smoke` 提供一次授权、单合成 trace、零业务 Provider 调用的真实连通性验证入口。
