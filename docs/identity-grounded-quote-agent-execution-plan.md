# 身份证据驱动的报价 Agent：实施、测试与验收计划

## 1. 最终目标

在不重写 durable runtime、BuyWhere adapter 和 PostgreSQL 原子提交的前提下，把当前字符串驱动的报价 Agent 升级为：

> LLM 负责理解和提出带来源的身份假设；版本化 Identity Resolver 负责商品与 Variant 身份；Domain 决策器负责查询授权、状态转换和 Offer 发布；Runtime 只执行受控 Effect。

完成标准不是“新类型存在”或“单个 Sony 用例通过”，而是本计划所有阶段依序批准，产品契约能在 Domain、Agent、Provider replay 和 vertical slice 四层执行。

## 2. 不可降级的设计边界

1. 保持 `quote-leads-sg-v1` 的新加坡已知型号报价线索产品边界。
2. BuyWhere 是动态报价来源，不是 Canonical Product 身份权威。
3. 型号字母数字不能被 LLM、编辑距离或模糊匹配静默修改。
4. LLM 不能授权 Provider 调用、Offer 准入、状态变更或事务提交。
5. 概率身份信号只能降级或触发澄清，不能提升发布权限。
6. 用户目标身份与 Provider Offer 身份必须分别解析。
7. `USER_CONFIRMED_LITERAL` 必须保留，避免身份库覆盖不足阻塞长尾型号。
8. 具体品牌、型号和 Provider Query Alias 进入版本化数据，不继续进入源码条件分支。
9. 通用附件、服务和成色词法信号可以保留为失败关闭防线，但必须独立、版本化且不能构成正向身份授权。
10. 保持模块化单体、现有数据库和原子提交；不引入图数据库、微服务或完整 Event Sourcing。
11. 每阶段结束都必须运行该阶段行为测试、架构检查和 `identity:drift:check`。
12. 任何失败都在原阶段修复，不能通过删除负向样本、放宽断言或改写最终目标获得批准。

## 3. AI Agent 产品测试模型

传统单元测试不足以证明 Agent 产品。验收必须区分：

| 层 | 被测对象 | 必须证明什么 |
| --- | --- | --- |
| Domain trajectory | Command、证据、状态转换 | 无模型参与时，业务不变量和调用预算确定成立 |
| Agent protocol eval | LLM 输出、schema、repair loop | 模型只能提出允许的结构，错误计划被宿主拒绝并最多修复一次 |
| Provider replay | BuyWhere envelope 与记录 | 结果、空、退化、失败、重复记录、附件污染均正确映射 |
| Durable vertical slice | Worker、数据库、API、UI | 重启、重试、fencing、原子提交和多轮指代不丢失 |
| Adversarial/property | 组合输入与代码变异 | 标点可归一化，字母数字/Variant/角色冲突不能越权 |
| Scheduled live observation | 当前 BuyWhere | 只发现能力和契约漂移，不把可变数量当产品保证 |

每条 Agent trajectory 至少断言：最终 route、Command 顺序、Provider 调用次数、Assistant outcome、状态版本、证据引用、公开声明禁区以及失败时是否保持原状态。

## 4. 分阶段实施顺序

### 阶段 0：机器合同与可信基线

交付物：ADR-0009、机器合同、本计划、阶段状态、独立漂移检查。

测试：现有 quote contract/drift、docs、maintainability、typecheck 和 unit baseline；新合同检查必须验证信任边界、身份强度矩阵和 0..6 阶段顺序。

批准标准：所有阶段0命令成功；工作树中不存在未说明的生成物；批准证据记录具体命令与结果。

本质反思：门禁是在执行语义，还是只检查字符串存在？

### 阶段 1：可执行产品契约与 Agent trajectory

交付物：机器可读 trajectory、受控 Provider/FX fixtures、实际执行 `QuoteConversationTurnExecutor` 的 harness、Faux LLM protocol eval。

必须覆盖：

- 精确型号首次查询与零调用比较；
- 合法标点别名；
- 型号字母数字冲突与显式确认；
- 附件、维修、替换件失败关闭；
- Provider empty、degraded、recovered；
- 重复 URL 分组与“记录数不是商家数”；
- 显式刷新、持久排除、目标纠正与恢复；
- LLM 不调用工具、非法计划、repair 成功、repair 失败和中止。

批准标准：trajectory 不是计数器，必须逐轮执行并比较实际 route、operation、调用次数、outcome 和状态；契约 route 与实现使用同一枚举。

本质反思：测试证明的是模型记住一个样例，还是宿主在任意模型输出下仍然安全？

### 阶段 2：版本化最小身份内核

交付物：IdentityResolution 类型、纯 Resolver、registry port、PostgreSQL identity migration、种子数据、旧状态 upcast。

身份表只包含 Brand、Product、Variant、Identifier、Alias、Relationship；Alias 具有 `PROPOSED/APPROVED/RETIRED`、用途、来源和版本。

测试：

- GTIN 与品牌+MPN唯一性；
- User Alias 与 Provider Query Alias 分离；
- 未审批 Alias 不能授权；
- 相同 alias 指向多个 Variant 时必须 `NEEDS_CONFIRMATION`；
- 无 registry 命中时显式确认落入 `USER_CONFIRMED_LITERAL`；
- 旧持久化 QuoteTarget 可确定性 upcast，不改变 `targetRef`；
- RLS、唯一约束、迁移重复执行和 repository integration。

批准标准：至少覆盖当前机器合同中的全部品牌和每种 hard-negative 类别；不得用 BuyWhere 标题自动生成已审批身份。

本质反思：数据库只是搬运了硬编码，还是建立了来源、审批、版本和冲突语义？

### 阶段 3：纯领域决策器与 Effect 边界

交付物：纯 Command decision、显式 Effect、Effect result application、薄 Agent executor。

测试：

- 同一输入重复决定产生相同输出且不调用外部服务；
- `NEEDS_CONFIRMATION/UNRESOLVED` 永远产生零 Provider Effect；
- Provider Effect 每轮最多一个；
- Effect 失败不部分修改状态；
- refresh、exclude、comparison、focus 的状态不变量；
- executor 不再包含业务状态字段拼装；
- 现有 PostgreSQL atomic commit、fence 与 restart integration 全部通过。

批准标准：Domain 不依赖 Agent、Runtime、数据库或 BuyWhere；Runtime 不重新解释业务规则。

本质反思：是否只是把大函数拆成更多文件，还是状态所有权真正移动到了 Domain？

### 阶段 4：受约束 LLM IdentityHypothesis

交付物：IdentityHypothesis schema、source span 校验、Resolver 候选 allowlist、澄清协议、离线 Alias proposal。

测试：

- LLM 输出的 brand/model/qualifier 必须能映射到原文 span；
- productRef/variantRef 只能来自宿主提供的候选；
- LLM confidence 不进入授权函数；
- 数字或字母变更只能产生候选澄清；
- prompt injection、自由文本回复、额外工具、重复工具调用均失败关闭；
- model refusal、malformed tool call、repair exhaustion 发布确定性 degraded 且不改写旧状态。

批准标准：更换 Faux 输出或模型错误不能改变 Domain 不变量；LLM 的安全性依赖宿主校验，而不是 prompt 承诺。

本质反思：LLM 是受约束语义协处理器，还是换名后的业务裁判？

### 阶段 5：Offer 身份证据、影子比较与单路径切换

交付物：OfferIdentityStrength、目标/Offer 双解析、影子 resolver 指标、Provider 字段兼容、单路径切换。

测试：

- strong identifier、curated title alias、exact lexical、probabilistic 和 conflict 五档；
- 概率候选永不进入 QuoteLead；
- 套装、容量、地区、成色和角色冲突优先于低价；
- Provider 新增字段只在 adapter 解析一次；缺字段继续失败关闭；
- shadow 模式只记录差异，不改变公开结果或产生双写；
- 切换后只有一个活动身份解析实现。

批准标准：gold set 中 hard-negative 发布数为零；每个 QuoteLead 均能说明 admission strength、policy version 和 evidence refs。

本质反思：是否为了召回率把模糊信号重新包装成“证据”？

### 阶段 6：对抗性验收与完成审计

交付物：属性测试、关键模块 mutation testing、脱敏 live observation、逐项完成审计和最终 ADR 状态。

测试：

- 每个支持型号具有 canonical、标点别名、相邻型号、附件/服务、Variant 与成色用例；
- 属性测试可重放 seed 并缩小反例；
- 删除身份门禁、反转冲突条件、放宽调用预算的 mutant 必须被杀死；
- 全量 unit、coverage、integration、E2E、build、lint、architecture、quote drift 和 identity drift；
- 真实 BuyWhere 验证状态分类和字段漂移，不要求固定记录数。

批准标准：逐项证据覆盖机器合同全部边界；没有未执行的 assertion、未解释的 shadow disagreement 或永久双实现。

本质反思：完成结论来自当前证据，还是来自计划、意图和曾经通过的报告？

## 5. 每阶段统一批准协议

1. 检查前一阶段已有 `APPROVED` 证据，不跳阶段。
2. 实现该阶段最小但完整的纵向能力，不以临时兼容替代目标架构。
3. 先运行职责测试，再运行 Agent trajectory、架构门禁和漂移检测。
4. 检查 git diff，确认没有无关改动、生成物、密钥或真实 Provider payload。
5. 写入 `docs/acceptance/identity-grounded-phase-<n>-*.md`，逐条记录命令与结论。
6. 只有全部门禁成功才更新 `spec/identity-grounded-quote-state.json`。

任何阶段状态文件不得先于实际证据标记完成。
