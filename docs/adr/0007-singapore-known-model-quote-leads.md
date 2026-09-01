# ADR-0007：收敛为新加坡已知型号报价线索助手

- 状态：Accepted for implementation
- 日期：2026-09-01
- 替代：ADR-0004 中“跨市场商品推荐”业务语义
- 保留：ADR-0004 的 durable Conversation Turn Runtime，以及 ADR-0003 的来源充分性原则

## 决策

InteRecAgent 的唯一首发产品边界调整为：面向新加坡市场，针对用户已经知道的商品型号，查询 BuyWhere 报价记录，经过确定性型号与商品角色校验后，提供报价线索和商家页入口。

系统不再承担通用品类推荐、多市场选择、配送目的地规划或最终购买判断。用户可见结果只能表述为 BuyWhere 在某一观察时间返回的报价记录；最终价格、准确型号/版本、成色与是否可购买必须由用户在商家页确认。

Buyer-facing BuyWhere 调用需要的 `deliver_to=SG` 固定封装在 Provider adapter 内部。它表示本产品固定服务的新加坡范围，不进入用户 Goal，不向用户追问，也不被表述为已经验证的配送事实。

## Provider 决策

报价主链路使用 MCP v2 `find_best_price_v2`。该工具没有 `mode` 参数，因此领域端口不暴露搜索模式。

`search_products_v2` 的 `keyword`、`semantic` 与 `hybrid` 仅属于通用目录搜索能力。当前真实探针不能证明 typo/fuzzy 能力，且 semantic/hybrid 在已知型号新加坡样本上没有达到可用门槛，因此不得作为用户报价链路的自动 fallback。REST `sort=price_asc` 同样不得作为静默 fallback。

Provider 的 HTTP 200 不是业务成功条件。实现必须解析 envelope/meta，将非退化空结果、退化、超时、熔断、限流和契约漂移分别建模；任何退化或失败都不能发布为“没有报价”。

## 领域决策

用户型号必须经过确定性规范化和确认。标点、空格与连字符可以规范化；型号中的字母或数字不得通过编辑距离或模型推断静默修改。

主商品查询采用白名单准入：完整型号、必要配置和预期商品角色必须一致；配件、维修、替换件和服务记录不得进入用户 QuoteLead。

每条 BuyWhere 原始记录保存为 `QuoteObservation`。用户看到的 `QuoteLead` 按规范化商家目标 URL 与成色分组，所有分组成员必须保留。记录数量不等于商家数量。

原币金额是主要报价事实；CNY 仅为带汇率时间的估算。FX 不可用时仍可展示原币报价。Provider availability 只保存在原始证据中，不产生“当前有货”声明，也不参与排序。

## 对话与结果语义

新业务结果只有：普通对话、型号确认、报价线索、无可展示报价线索、服务退化。`RECOMMENDATION` 和通用 `SEARCH_RESULTS` 不属于新产品合同。

报价线索可以在同一会话中被聚焦、比较、排除和再次检查；这些操作在现有证据充分时保持零 Provider 调用。用户明确要求刷新时必须执行新的 Provider observation，不能用跨会话候选缓存冒充刷新结果。

## 保留的架构资产

以下能力不因业务域调整而重写：PostgreSQL 权威状态、Turn lease/fencing、幂等 Provider ledger、attempt-scoped draft、原子发布、RLS、outbox、artifact/source fact/claim/evidence 链、稳定指代绑定，以及 `commit_turn_plan → execute → publish_reply` 协议。

## 不兼容迁移

旧跨市场推荐会话不得自动解释为新加坡报价会话。新会话写入新的 product contract version；旧会话只读或引导用户开始新会话。迁移期间允许旧表保留，但最终只有一个活动业务实现，不保留运行时 fallback 或双写。

## 验收依据

机器可读产品合同为 `spec/quote-lead-product-contract.json`。实施顺序、阶段审批和漂移门禁见 `docs/quote-lead-refactor-execution-plan.md`。只有所有开发门禁和真实 BuyWhere 多用例验收均通过，ADR 状态才可从 “Accepted for implementation” 更新为 “Accepted”。
