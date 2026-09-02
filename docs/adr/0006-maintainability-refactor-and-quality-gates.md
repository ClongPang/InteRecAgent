# ADR-0006：可维护性重构与质量门禁

- 状态：Superseded
- 日期：2026-08-31
- 被替代：ADR-0008（模块边界与门禁）

## 仍有效的原则

公开入口保持稳定；按变化轴拆职责，不搞大爆炸分层重写。默认验收仍包含文档漂移、lint、覆盖率、E2E、PostgreSQL 集成和 `npm run acceptance`。

## 不要从本文恢复

已退役的执行器入口、双工具协议、以及“Telemetry 默认不记录正文”。现行模块方向、行数预算和门禁见 ADR-0008。正文默认采集，关闭方式见 `spec/observability/agent-trace-contract.json`。
