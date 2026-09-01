# 新加坡已知型号报价线索助手：执行与验收计划

## 1. 最终目标

在保留 durable Conversation Runtime、来源证据链和一致性机制的前提下，将活动业务实现从“跨市场商品推荐”替换为：

> 面向新加坡市场，针对用户已知商品型号，通过 BuyWhere 获取报价记录，经过确定性身份准入和商家页级分组后，返回带原币价格、CNY 估算、记录时间和购买入口的报价线索；用户在商家页确认最终价格、准确型号/版本、成色与是否可购买。

完成并不以代码可编译或单个示例通过为准。只有本文件第 3 节的全部验收标准、所有阶段门禁和真实多用例验收都具有当前证据时，重构才算完成。

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

### 3.1 产品合同

- 活动文档、Prompt、Schema、API 与 UI 使用“报价线索/商家页确认”语义。
- 活动类型中不存在 `RECOMMENDATION`、通用 `SEARCH_RESULTS`、用户市场选择和配送目的地。
- 新 Conversation 带 `quote-leads-sg-v1` contract version。

### 3.2 Provider 合同

- 报价端口是领域无关的 `QuoteProvider`，主实现映射到 MCP v2 `find_best_price_v2`。
- 每次 buyer-facing 调用由 adapter 内部固定 `deliver_to=SG`。
- Provider 结果显式区分 `OK_RESULTS`、`OK_EMPTY`、`DEGRADED` 和 `FAILED`。
- 主链路不存在 keyword/semantic/hybrid 参数，也不存在 REST 或通用搜索自动 fallback。
- 原始 envelope、meta、观察时间和契约版本进入 artifact。

### 3.3 型号与候选安全

- NFKC、大小写、空格和连字符变化可确定性规范化。
- 型号字母数字变化触发确认，不静默修改。
- 完整型号、必要配置和 item role 是硬门禁。
- service/accessory/replacement/repair 样本全部拒绝且保留拒绝原因。
- 任何身份不充分的 observation 默认不展示。

### 3.4 报价与证据

- `QuoteObservation` 保留原始记录；`QuoteLead` 保留 observation 关系。
- 同 URL、同成色记录聚合为一个线索，记录数不被表述为商家数。
- 每个线索包含原币价格、商家域名、HTTPS outbound URL、Provider 更新时间（如有）和本系统观察时间。
- CNY 估算包含 FX snapshot；FX 失败时仍展示原币报价。
- 用户可见声明均可追溯到 source fact 或有版本的确定性派生规则。

### 3.5 对话行为

- 已确认型号首次查询产生一次逻辑报价调用。
- 型号不确定时只澄清，不调用 Provider。
- 比较、聚焦、排除、解释现有线索保持零 Provider 调用。
- 用户明确刷新时产生新 observation。
- 无报价、全部被拒和 Provider 退化具有不同 reason code。
- Worker 重启、浏览器刷新和 SSE 重连不破坏 QuoteLeadSet 指代。

### 3.6 用户体验

- 卡片以原币报价为主、CNY 为辅。
- 展示成色、商家域名、记录时间、检索时间和记录数量。
- 每条线索具有“打开商家页确认”入口和 affiliate disclosure。
- UI 不显示“有货”或配送结论。
- 回复不出现未经限定的“最佳、最便宜、当前有货、可以买”。

### 3.7 工程质量

- 类型、单元、集成、E2E、构建、lint、覆盖率和架构门禁通过。
- Quote Provider、型号解析、准入、分组、证据投影和持久化职责分离。
- façade 行数与依赖方向受维护性脚本约束。
- 新的漂移检查进入默认 acceptance 命令。
- 旧活动业务路径、旧 Prompt 和旧用户界面在切流后被删除，而不是长期双写。

### 3.8 真实 BuyWhere 验收

真实验收必须记录时间、工具、固定 SG 范围、Provider 状态、原始记录数、拒绝数、分组数和用户结果；不得持久化 API key。

必测用例：

1. Sony WH-1000XM5：验证同页多记录分组、翻新成色、原币价格区间和商家页入口。
2. Sony 精确型号的配件污染：所有配件不得进入 QuoteLead。
3. Nintendo service/display-service：全部拒绝。
4. 明显错拼型号：不得静默改写或伪造报价。
5. 非退化空结果：发布 `NO_QUOTE_LEADS`。
6. degraded/timeout/circuit-open：发布 `DEGRADED`，不发布无报价。
7. 至少一个返回不同原币的结果：保留原币并验证 FX 估算边界。
8. 商家页与 Provider availability 不一致：用户回复中不存在当前库存结论。

实时目录具有可变性，因此具体结果数量不是永久门槛；状态解释、准入不变量、证据完整性和禁止声明才是门槛。

## 4. 分阶段执行顺序

### 阶段 0：合同与基线

交付物：ADR、机器合同、本计划、阶段状态、漂移检查；记录当前测试基线。

进入条件：工作树已检查；现有类型、单元和架构门禁已有可重复基线。

批准条件：`quote:contract:check`、`quote:drift:check`、现有 docs/product/architecture/maintainability/typecheck/unit 全部通过。

反思问题：目标是否仍含推荐、多市场或配送语义；验收是否把可变的实时数量误当永久产品保证。

### 阶段 1：Provider 纵向切片

交付物：独立 Quote Provider 端口、BuyWhere MCP v2 adapter、envelope 状态解析、replay contract tests、受控 live probe。

进入条件：阶段 0 批准。

批准条件：Provider 单元/契约测试覆盖结果、空、退化、失败、契约漂移；不存在自动 fallback；真实探针能够生成脱敏报告。

反思问题：领域是否泄漏 BuyWhere tool 名或 mode；HTTP 200 是否仍可能绕过 meta 状态。

### 阶段 2：领域、证据与持久化

交付物：QuoteTarget、QuoteObservation、QuoteLead、严格准入、分组、FX 投影、QuoteLeadSet、状态语义、迁移与 repository。

进入条件：阶段 1 批准。

批准条件：真实探针的冻结 replay 覆盖配件/service/重复 URL/多币种；PostgreSQL 集成测试证明原子发布、RLS、fencing 和 observation 关系。

反思问题：任何不充分结果是否通过排序或 semantic 信号重新进入展示；审计留存是否被误当新鲜度。

### 阶段 3：Agent、API 与 UI

交付物：报价专属 operations、Prompt/schema/policy、API projection、QuoteLead 卡片、商家页跳转和多轮指代。

进入条件：阶段 2 批准。

批准条件：自然语言型号确认、初查、比较、排除、刷新、故障语义的 contract/E2E 通过；UI 不包含库存、配送和推荐表达。

反思问题：LLM 是否仍能控制自由查询或事实；内部枚举是否泄漏给用户；外链是否保留来源和安全属性。

### 阶段 4：单实现切流与全量质量

交付物：新会话默认 v2 contract、旧会话兼容边界、旧活动业务路径删除、所有默认门禁更新。

进入条件：阶段 3 批准。

批准条件：`npm run acceptance` 及 quote 专属门禁全部通过；仓库搜索确认没有活动推荐、多市场、配送和自动 fallback 语义。

反思问题：是否形成永久双实现；测试是否仍只证明旧产品；维护性边界是否因重构膨胀。

### 阶段 5：真实多用例验收与完成审计

交付物：脱敏 live report、重复运行的 contract fingerprint、逐项完成审计和最终 ADR 状态。

进入条件：阶段 4 批准。

批准条件：第 3 节每项均有当前证据；所有必测 live 类别都有非伪造结果或被正确分类的 Provider 退化证据。

反思问题：是否把单次实时成功外推为稳定覆盖；是否把 Merchant 页面、BuyWhere 记录和系统观察混为同一事实。

## 5. 每阶段统一审批协议

每个阶段按以下顺序执行，不得跳步：

1. **实现审查**：变更是否直接推进最终产品合同，是否引入不必要基础设施。
2. **行为审查**：正向、负向、故障和多轮用例是否覆盖该阶段职责。
3. **事实审查**：所有用户事实是否有来源，未知是否保持未知。
4. **维护性审查**：领域、Provider、持久化、Agent 和展示依赖是否单向；职责文件是否超预算。
5. **漂移检测**：运行 `npm run quote:drift:check` 和已有架构/产品/文档门禁。
6. **批准记录**：只有所有命令成功并记录证据，才更新阶段状态。

任何阶段失败都在原阶段修复；不得通过放宽最终合同、删除负向用例或把错误改名为 warning 获得批准。
