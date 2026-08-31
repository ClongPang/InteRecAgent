# ADR-0006：可维护性重构与质量门禁

- 状态：已批准
- 日期：2026-08-31
- 范围：文档漂移、离线质量门禁、浏览器回归、`ConversationTurnExecutor`、PostgreSQL Repository、Telemetry

## 背景

项目的领域边界和运行时安全语义已经稳定，但三个实现文件同时承担了过多职责：

- `ConversationTurnExecutor` 混合计划来源校验、指代冻结、策略审批、操作执行和回复发布；
- `PostgresConversationRepository` 混合行映射、快照恢复、Turn 生命周期、最终晋级事务和查询接口；
- `telemetry.ts` 混合配置、脱敏、指标注册、Agent 因果图和通用 Span 生命周期。

此外，架构文档仍包含已经删除的操作名和文件名，测试门禁没有覆盖率下限、静态检查和浏览器级购物流程。

本次工作的约束是：不能以“拆文件”为名改变 Agent 协议、Conversation revision、Provider 授权、fencing、Claim/Evidence 或默认隐私语义。

## 多轮自我否定审批

### 第一轮：否定大爆炸分层重写

候选方案：一次性把三个热点文件改写为新的 service/repository/observer 类层级，同时修改调用方。

否定理由：

1. PostgreSQL 最终提交、Agent fallback 和 Trace 因果关系都是高风险语义；同时改动后，失败无法归因到单一边界。
2. 现有 300 余项测试主要验证行为，不足以证明一次大规模内部重写保持所有失败时序。
3. 大量新接口会先增加抽象数量，再等待实现证明其价值，违背按变化轴提取职责的原则。

### 第二轮：否定 façade 和逐方法碎片化

候选方案 A：保留原文件全部逻辑，只增加三个 façade 文件转发调用。

否定理由：依赖方向和修改半径没有变化，文件行数下降也只是视觉效果，不能提高可维护性。

候选方案 B：每个方法一个文件，所有内部状态通过长参数列表传递。

否定理由：会形成贫血模块和循环依赖；事务内共享的锁、owner context、fence 与 staged state 被拆散后反而更难审计。

### 第三轮：否定同时改变行为的“顺手优化”

候选方案：抽取期间顺便调整澄清策略、搜索规则、数据库结构、Trace 名称或前端交互。

否定理由：结构迁移与产品语义必须分开验收。否则即使测试失败，也无法判断是边界迁移还是行为变更。

### 最终批准方案

采用“公开入口稳定、按内聚职责抽取、逐步验收”的方案：

1. Agent：抽取 `proposal-grounding` 和 `referent-planning`。前者只处理当前消息到模型提案的可审计绑定，后者只把相对指代冻结为稳定候选引用。
2. Repository：抽取 PostgreSQL 行映射/快照恢复，以及最终 Turn 晋级事务。Repository 类继续实现原接口，负责组合，不增加第二套持久化入口。
3. Telemetry：抽取安全配置/脱敏、Agent 因果观察器和运行时指标注册；`telemetry.ts` 保留公共导出与通用运行时 Span 生命周期入口。
4. 每次迁移只移动现有语义，保留原测试；新增结构门禁阻止热点重新膨胀或旧名称回流。
5. 质量门禁增加 ESLint、覆盖率下限和 Playwright 浏览器购物流程；PostgreSQL 集成测试必须在显式隔离的 `interec_test` 数据库执行。

依赖方向固定为：

```text
domain pure policy
       ↑
agent proposal/referent modules ← ConversationTurnExecutor orchestration
       ↑
runtime postgres/telemetry components ← public Repository/Telemetry façade
       ↑
api / worker / frontend
```

## 可验证不变量

重构完成必须同时满足：

1. `ConversationTurnExecutor` 仍是唯一 `TurnExecutionController` 实现入口；模型仍只能使用 `commit_turn_plan` 和 `publish_reply`。
2. 每个自然语言计划仍经过来源绑定、PlanReview 和有界修复；结构化 UI 输入仍明确标记其 authority。
3. Provider 调用预算、租户配额、幂等 step key、lease 和 fence 行为不变。
4. Goal、Dialogue、WorkingSet、AssistantEnvelope、Claim、Evidence 和 Event 仍在同一最终事务晋级。
5. Telemetry 默认不记录正文，敏感字段脱敏规则和 Trace/Tool 因果主键不变。
6. 文档不得引用已删除的活动代码符号；历史数据库表名可以保留，但必须明确它是持久化名称而不是当前操作名。

## 验收矩阵

| 目标 | 权威证据 |
| --- | --- |
| 文档无活动命名漂移 | `npm run docs:check` |
| 静态质量 | `npm run lint` 零 warning |
| 覆盖率不回退 | `npm run test:coverage` 达到已冻结阈值 |
| 浏览器购物主路径 | `npm run test:e2e` |
| PostgreSQL/RLS/fencing/原子提交 | `npm run test:integration` 使用 `interec_test` |
| 领域与 Agent 行为不变 | `npm run test` 与全部架构契约 |
| 所有 workspace 可发布构建 | `npm run build` |
| 总门禁 | `npm run acceptance` |

## 后果

收益是职责和失败归因更清楚，并由自动门禁防止回退。代价是内部模块数量增加，Repository 和 Telemetry 的 façade 仍然存在；这是为了保持公开 API 和事务语义稳定，而不是宣称已经拆成微服务。
