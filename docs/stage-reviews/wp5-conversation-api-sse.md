# WP5 阶段审视：Conversation API、SSE 与服务组合

## 完成范围

- 正式 HTTP 契约已替换为 `/api/conversations`、`/api/conversations/:id/turns`、ConversationProjection、message cursor、Conversation event SSE、cancel 和 retry；删除了旧 Run/Decision API 源入口。
- `MESSAGE | PATCH_GOAL | UNDO | SET_COMPARISON` 共用 durable Turn 边界。失败 retry 复用原未消费 USER batch，不创建重复用户消息。
- ConversationProjection 返回当前 revision、Goal/Dialogue/WorkingSet、最近消息、最新 AssistantMessage、active Turn 和权威 event cursor；不再要求客户端在 stream 结束后 GET 一次 Decision。
- SSE 以 Conversation 单调序号和 `Last-Event-ID` 恢复，事件来自权威 `turn_events` 数据库读模型。
- API 身份由 HS256 Bearer JWT 的 signature/issuer/audience/expiry/tenant/sub 共同绑定；`x-tenant-id/x-actor-id` 不再被信任。
- owner-facing repository 操作在同一事务中设置 tenant/owner local context；核心 Conversation、Turn、状态、消息、证据和 research 表启用 RLS。生产 worker 使用独立受控数据库角色。
- `/health/live` 只表达进程存活；`/health/ready` 验证数据库连接和完整 schema verifier。
- 新 `ConversationWorker` 组合 repository、fresh pi-agent、DraftHost、ResearchWorld、provider governance 和原子 publication。全 typed USER batch 走确定性快路径；包含任一自然语言消息时，完整 batch 交给 pi-agent，不遗漏 supersede 前消息。
- 未消费 USER batch 上限为八条；纯 typed batch 的总 operation 上限为十二条，超限在接收事务中 fail closed。
- outbox 不再是名义能力：实现 `SKIP LOCKED` claim、lease takeover、指数退避、稳定 event ID、最大尝试、dead letter 与 backlog；未删除任何可能未投递的数据。

## 测试证据

- 离线单元：14 个文件、185 项通过；API 覆盖 JWT、拒绝自报身份、Projection、SSE cursor 与 live/ready 分离。
- PostgreSQL 集成：2 个文件、22 项通过；新增 retry 无重复消息、事务内 FORCE RLS 跨 owner 隔离、outbox retry/dead-letter、typed worker 零模型/零 Provider，以及 HTTP → worker → AssistantMessage → Projection → SSE 纵向切片。
- 产品、architecture、workflow、typecheck 与所有 workspace build 全部通过。

## 定位与偏移审视

API 的主资源是长期 Conversation，不是单次 Run；普通 CHAT/CLARIFICATION 同样发布 AssistantMessage 和 revision，不再被 Decision 终态截断。

worker 没有恢复旧 research-only handler：每次 attempt 仍从 bounded snapshot 创建 fresh pi-agent，先提交完整 TurnPlan，再由 deterministic host 执行 world operations 并发布 reply。

typed controls 是 UI 的确定性快捷输入，不是第二套业务引擎。它们进入同一 TurnPlan/reducer/final commit；混合自然语言 batch 仍由 pi-agent 统一理解，避免只执行最后一个 chip 的漂移。

本阶段修复的是协议与权限不变量，而不是首页 `NOT_FOUND` 的路由补丁。旧页面仍未接新 API，因此没有用兼容 endpoint 伪装修复；真正 UI 接线属于 WP6。

## 明确未完成

- WP6：对话 thread、composer、conditions、progress、candidate workspace、drawer/compare、刷新恢复、移动端与可访问性。
- WP7：真实模型/Provider、浏览器端到端、gold/shadow/SLO 和人工审计。
- WP8：删除旧 `interec_v2` 文件、旧配置迁移脚本与 `:v2` 命令命名。

## 阶段裁决

WP5 达到进入 WP6 的条件。WP6 必须直接消费 ConversationProjection 与 SSE，不得保留旧 `/v2/runs/:id/decision` client，也不得在浏览器重新生成 tenant/owner 身份。
