# 身份证据驱动的报价 Agent：实施、测试与验收计划

状态：Completed / APPROVED（2026-09-01，`spec/identity-grounded-quote-state.json` phase 6）

本文件是已完成实施的摘要，不是待办阶段清单。审批索引见 [completed-phases.md](acceptance/completed-phases.md)。

## 1. 最终目标

在不重写 durable runtime、BuyWhere adapter 和 PostgreSQL 原子提交的前提下，报价 Agent 的现行分工是：

> LLM 提出带来源的身份假设；版本化 Identity Resolver 负责商品与 Variant 身份；Domain 决策器负责查询授权、状态转换和 Offer 发布；Runtime 只执行受控 Effect。

## 2. 不可降级的设计边界

1. 保持 `quote-leads-sg-v1` 的新加坡已知型号报价线索产品边界。
2. BuyWhere 是动态报价来源，不是 Canonical Product 身份权威。
3. 型号字母数字不能被 LLM、编辑距离或模糊匹配静默修改。
4. LLM 不能授权 Provider 调用、Offer 准入、状态变更或事务提交。
5. 概率身份信号只能降级或触发澄清，不能提升发布权限。
6. 用户目标身份与 Provider Offer 身份必须分别解析。
7. `USER_CONFIRMED_LITERAL` 必须保留，避免身份库覆盖不足阻塞长尾型号。
8. 具体品牌、型号和 Provider Query Alias 进入版本化数据，不继续进入源码条件分支。
9. 通用附件、服务和成色词法信号可以保留为失败关闭防线，但不能构成正向身份授权。
10. 保持模块化单体、现有数据库和原子提交。
11. 复验运行职责测试、架构检查和 `identity:drift:check`。
12. 不得通过删除负向样本、放宽断言或改写最终目标获得通过。

## 3. AI Agent 产品测试模型

| 层 | 被测对象 | 必须证明什么 |
| --- | --- | --- |
| Domain trajectory | `spec/identity-grounded-agent-trajectories.json` | 命令、授权和状态结果 |
| Provider replay | 受控 Effect | 调用预算与身份准入 |
| Planner eval | `identity:agent:eval` | 假设带 source span，宿主可拒绝 |
| Vertical slice | PostgreSQL / API / UI | 发布与指代不被 LLM 改写 |

## 4. 已完成阶段

阶段 0–6 已批准。机器合同是 `spec/identity-grounded-quote-contract.json`。ADR 是 [0009](adr/0009-identity-grounded-agent-decision-core.md)。

## 5. 每阶段统一批准协议

后续变更不再写 `docs/acceptance/identity-grounded-phase-<n>-*.md`。更新 `spec/identity-grounded-quote-state.json` 与合同，并让 `npm run identity:drift:check` 通过。
