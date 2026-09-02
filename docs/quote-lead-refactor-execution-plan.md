# 新加坡已知型号报价线索助手：执行与验收计划

状态：Completed / APPROVED（2026-09-01，`spec/quote-lead-refactor-state.json` phase 5）

本文件保留合同与门禁摘要，不再当作未完成路线图。审批索引见 [completed-phases.md](acceptance/completed-phases.md)。

## 1. 最终目标

在保留 durable Conversation Runtime、来源证据链和一致性机制的前提下，活动业务实现是：

> 面向新加坡市场，针对用户已知商品型号，通过 BuyWhere 获取报价记录，经过确定性身份准入和商家页级分组后，返回带原币价格、CNY 估算、记录时间和购买入口的报价线索；用户在商家页确认最终价格、准确型号/版本、成色与是否可购买。

## 2. 不可降级的边界

1. 新加坡是固定服务范围，不是用户 Goal；不询问或保存配送目的地。
2. 已知型号或完成型号确认后才允许报价查询。
3. 报价主链路只使用 `find_best_price_v2`；`search_products_v2` 不得自动兜底。
4. Provider 的 degraded、timeout、circuit-open、rate-limit 与 contract-drift 不得转成无报价。
5. 型号数字或字母不得被 LLM 或编辑距离算法静默纠正。
6. 配件、维修、替换件和服务结果不得进入主商品 QuoteLead。
7. 原始 BuyWhere 记录全部保留；用户线索按规范化商家页 URL 与成色分组。
8. 原币价格是主要事实，CNY 是带时间的估算；FX 失败不能删除原币报价。
9. Provider availability 不得发布为当前库存，不参与报价排序。
10. 用户可见结果只能是报价线索，不能发布为推荐、全网最低、当前可购买或已验证配送。
11. 跨会话候选缓存不得充当当前报价；刷新必须产生新 observation。
12. 旧推荐会话不得被无损假设地解释为新报价会话。

## 3. 最终验收矩阵

权威机器合同是 `spec/quote-lead-product-contract.json`。下面是仍需守住的验收面。

### 3.1 产品合同

活动文档、Prompt、Schema、API 与 UI 使用“报价线索/商家页确认”语义。活动类型中不存在 `RECOMMENDATION`、通用 `SEARCH_RESULTS`、用户市场选择和配送目的地。新 Conversation 带 `quote-leads-sg-v1`。

### 3.2 Provider 合同

报价端口是领域无关的 `QuoteProvider`，主实现映射到 MCP v2 `find_best_price_v2`。每次 buyer-facing 调用由 adapter 内部固定 `deliver_to=SG`。Provider 结果显式区分 `OK_RESULTS`、`OK_EMPTY`、`DEGRADED` 和 `FAILED`。主链路不存在自动 fallback。

### 3.3–3.7 型号、证据、对话、UX、工程质量

`QuoteObservation` 保留原始记录；`QuoteLead` 保留 observation 关系。比较、聚焦、排除、解释现有线索保持零 Provider 调用。默认验收为 `npm run acceptance`。

### 3.8 真实 BuyWhere 验收

真实验收必须记录时间、工具、固定 SG 范围、Provider 状态、原始记录数、拒绝数、分组数和用户结果；不得持久化 API key。必测类别仍是精确型号、配件污染、service、错拼、空结果、退化、多币种和库存禁言。实时目录数量不是永久门槛。

## 4. 分阶段执行顺序

阶段 0–5 均已批准。不要再按阶段清单重做 cutover。复验使用 `npm run quote:drift:check` 与 `npm run quote:live:acceptance`。

## 5. 每阶段统一审批协议

每个阶段按以下顺序执行，不得跳步：实现审查、行为审查、事实审查、维护性审查、漂移检测、批准记录。任何阶段失败都在原阶段修复；不得通过放宽最终合同或删除负向用例获得批准。后续变更走现行合同与 drift 门禁，不再新开 phase 文档。
