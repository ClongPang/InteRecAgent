# ADR-0009：证据分级的商品身份与 Agent 决策内核

状态：Accepted  
Status: Accepted  
日期：2026-09-01

## 背景

当前 `quote-leads-sg-v1` 已经建立可靠的 Provider 状态、原始 Observation、准入、分组、fencing 与原子提交边界，但商品语义仍由会话字符串、品牌表和正则共同承担。真实 BuyWhere 探测进一步证明：合法标点别名可能直接变成 `no_match`，相同商家页可能返回多个不同记录 ID，而 `get_product_v2` 的抽样详情没有提供 GTIN、MPN、brand、model 或 Variant 字段。

这意味着 BuyWhere 是动态报价 Observation 来源，而不是 Canonical Product 身份权威。继续为品牌、型号、附件和 Variant 增加专用正则，会把身份解析、查询授权、Offer 准入和对话状态转换耦合在一起。

现有产品合同还存在另一类风险：机器检查只统计 trajectory、route 和 assertion 是否存在，没有执行 Agent 提议、宿主策略、Provider 调用预算和状态结果。合同与实现可以同时“通过”却使用不同的 route 词汇。

## 决策

### 1. 保持模块化单体

不引入图数据库、商品微服务或完整 Event Sourcing。继续使用 `domain <- agent <- runtime <- api` 依赖方向和现有 PostgreSQL 原子提交。

### 2. 建立最小身份内核

稳定身份由 Brand、CanonicalProduct、ProductVariant、ProductIdentifier、ProductAlias 和 ProductRelationship 表达。标识与别名必须带来源、审批状态和版本。

身份解析同时返回 outcome 与 strength：

- outcome：`RESOLVED`、`NEEDS_CONFIRMATION`、`UNRESOLVED`；
- strength：`VERIFIED_IDENTIFIER`、`CURATED_ALIAS`、`USER_CONFIRMED_LITERAL`、`NONE`。

`USER_CONFIRMED_LITERAL` 保留当前长尾精确型号能力，但不能被表述成已验证 Product/Variant。

### 3. LLM 是语义协处理器，不是授权者

LLM 可以抽取带 source span 的身份假设、排序 Resolver 已提供的候选、生成澄清和解释已批准事实。LLM 不得发明标识、静默修改型号字母数字、授权 Provider 调用、提升身份强度、准入 Offer、修改状态或提交事务。

LLM 怀疑冲突可以使流程澄清或失败关闭；LLM 判断相似不能单独提升权限。

### 4. Domain 拥有命令决策和状态转换

Agent 只提出 Command。Domain 对当前状态、命令和证据作纯决策并返回 next state、receipt、violation 或 Effect。Runtime 解释 Effect、调用 Provider 并把结果交回 Domain。现有 final commit 继续负责 fencing、revision 和原子发布。

### 5. 用户目标身份与 Provider Offer 身份分开解析

目标解析成功只允许发起查询，不自动证明返回记录属于同一 Variant。Offer 只有在强标识、受控标题别名或确定性精确词法证据满足时才能发布；概率候选仅保留为 Observation。

### 6. 产品契约必须可执行

测试分为四层：

1. 纯 Domain trajectory；
2. 受控 Effect/Provider replay；
3. LLM planner/protocol eval；
4. PostgreSQL/API/UI vertical slice。

实时 BuyWhere 只用于观察上游能力和漂移，不作为稳定数量或具体商家的永久断言。

## 被否决的方案

- 继续增加品牌或型号专用正则：只能延后同一结构问题。
- 使用 LLM confidence、Embedding 或编辑距离直接授权发布：无法提供可审计的零误合并边界。
- 依赖 BuyWhere `get_product_v2` 自动补全身份：当前实测数据不支持。
- 立即建设完整知识图谱：超出已知型号报价线索产品的必要范围。
- 将全部流程改成 Event Sourcing：现有不可变 evidence、revision 和 atomic commit 已满足持久化需求。

## 后果

收益是品牌扩展、Provider 查询词、Variant 消歧和 LLM 能力可以分别演进，并且任何概率判断都不能越过确定性发布门禁。代价是需要小规模身份数据治理、兼容旧字面型号状态，并增加 trajectory 与 Agent eval 维护成本。

分阶段实施和批准标准见 [identity-grounded-quote-agent-execution-plan.md](../identity-grounded-quote-agent-execution-plan.md)。最终验证和上线边界见 [Phase 6 final approval](../acceptance/identity-grounded-phase-6-final-2026-09-01.md)。
