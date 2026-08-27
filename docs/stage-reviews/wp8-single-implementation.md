# WP8 阶段审视：单实现收口

## 完成范围

- 删除 Python/LangGraph 主链、旧 migrations/测试/脚本和旧 TypeScript Run/Decision runtime，不保留双写、兼容开关或旧入口。
- 删除被 ADR-0004 替代的单轮 ADR-0001；ADR-0002/0003 已修订为 Conversation Turn 与可选 Decision 边界。
- 根 package、workspace exports、README、Makefile、CI、环境变量和运维手册只指向 Conversation UI/API、PostgreSQL repository、durable Turn worker 与 fresh pi-agent。
- 运行命令统一为 `dev:api`、`dev:worker`、`acceptance`、`observability:smoke` 和受控 `live:turn:once`，无 `:v2` 或旧配置迁移入口。
- 活跃架构门禁递归拒绝旧 URL、旧身份 header、旧 RunStore/协议和 `INTEREC_V2_*`，并要求正式 CategoryContract/MarketContract registry。

## 漂移检查

- 最终主链保持 `ConversationSnapshot → fresh pi-agent → commit_turn_plan → ordered WorldOps → publish_reply → atomic revision`。
- headphones/smartphone 与 US/SG 是版本化 contract registry 的首批条目，不是核心层枚举分支或 bad-case 黑名单。
- 旧验收截图仅作为非执行审计 artifact；被忽略的 Python bytecode/空目录不参与构建、运行或部署。其物理删除需要单独的目录删除授权，不能据此恢复或引用旧实现。

## 验证

- product/architecture/workflow gates：通过。
- typecheck 与全 workspace production build：通过。
- unit/contract tests：16 files / 105 tests 通过。
- PostgreSQL/API integration：2 files / 23 tests 通过。
- `npm audit --audit-level=moderate`：0 vulnerabilities。
- `git diff --check`：无 whitespace error（仅 Windows LF→CRLF 提示）。

WP8 的代码与正式运行面已收口为单实现；这不改变 WP7 的真实发布验收缺口。
