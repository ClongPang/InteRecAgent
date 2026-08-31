# P1 验收：类型化计划审批与有界修复

- 日期：2026-08-30
- 阶段：`P1_TYPED_PLAN_REVIEW`
- 结论：通过

## 已交付

- 领域 `PlanReview`、`PlanPolicyViolation` 和版本化策略结果；
- `commit_turn_plan` 的 `APPROVED / REPAIR_REQUIRED / REJECTED` 结构化结果；
- 默认最多两次提案，即一次修复机会；
- 只有 `APPROVED` 计划写入并执行；
- PostgreSQL append-only `turn_plan_reviews` 审批账本；
- `PI_AGENT` 与 `STRUCTURED_INPUT` 的显式规划权边界；
- 审批 telemetry 与静态漂移门禁。

## 否决过的实现路线

1. 继续用异常 message 驱动修复：缺少稳定类型和可审计替代行为；
2. 让策略返回改写计划继续执行：执行轨迹与 Agent 提案失真；
3. 只写日志不持久化审批：不能完成 attempt/proposal 级复盘；
4. 让结构化 UI 输入复用自然语言计划补全：会把明确命令扩张成未授权搜索。

## 目标漂移检查

1. Pi-Agent 是否仍提出每个自然语言话轮的完整有序计划：是。
2. 策略是否成为第二个 planner：否；检测到语义变化时只返回修复要求。
3. 非批准计划是否可能改变 Goal、DialogueState、WorkingSet 或调用 provider：测试证明不会。
4. 是否增加了商品名、句式或单类目 badcase 控制流：否。
5. 是否保留双写生产路径：否；审批账本是审计写入，不是 Conversation 状态双写。
6. 是否提前声称 P2-P5 完成：否。

## 验收证据

- 领域、Agent、执行器定向测试；
- PostgreSQL 迁移和 24 项真实集成测试；
- TypeScript 全项目类型检查；
- `architecture:p1:check` 静态门禁。

