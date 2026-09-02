# RetailPriceAgent：MCP 与自定义 Agent Tool 业务架构分析

## 1. 结论

MCP 和 Agent Tool 不属于同一个架构层次，不应被理解为互斥选择：

- **Agent Tool** 是模型可调用的业务操作，决定模型被允许表达什么意图；
- **MCP** 是访问外部能力的一种标准协议，决定宿主如何连接外部工具或数据服务；
- **领域端口** 隔离业务语义与具体 Provider；
- **Provider Adapter** 负责把领域请求映射为 MCP、REST 或其他外部协议。

RetailPriceAgent 当前采用的是组合方案，而不是用 MCP 取代自定义 Agent Tool：

```text
LLM
  ↓ 调用项目自定义 Agent Tool
commit_quote_plan
  ↓ 宿主校验与授权
QuoteTurnExecutor
  ↓ 调用内部领域端口
QuoteProvider
  ↓ 由 Adapter 映射外部协议
BuyWhere MCP v2 / find_best_price_v2
```

这意味着 Agent 的业务控制面属于项目自身；MCP 只承担 BuyWhere 外部报价能力的接入职责。BuyWhere MCP 工具没有直接暴露给模型。

## 2. 四个概念的职责区别

| 层次 | 当前实例 | 主要职责 | 是否应包含业务政策 |
| --- | --- | --- | --- |
| Agent Tool | `commit_quote_plan` | 接收模型提交的结构化意图 | 只包含允许模型表达的业务操作 |
| 宿主执行器 | `QuoteTurnExecutor` | 审核、排序和执行操作 | 是，拥有确定性授权和状态变更 |
| 领域端口 | `QuoteProvider` | 表达业务所需的报价能力 | 是，但不能泄漏具体传输协议 |
| Provider Adapter | `BuyWhereMcpQuoteClient` | 调用外部服务并解释响应 | 包含 Provider 映射，不包含推荐决策 |
| MCP | BuyWhere MCP v2 | JSON-RPC、工具参数和结果 envelope | 否，它只是外部能力协议 |

因此，“自己实现 Agent Tool”不能替代 MCP 所连接的数据源。即使项目自行定义了一个 `lookup_quotes` Tool，其内部仍然需要通过以下方式之一获取真实报价：

- BuyWhere MCP；
- BuyWhere REST；
- 商家官方 API；
- 自建商品与报价数据服务；
- 网页采集系统。

## 3. 为什么当前外部接入选择 MCP

### 3.1 MCP 工具与当前报价任务匹配

当前产品任务是：用户提供已经确认的精确型号后，查询一次新加坡服务范围内的报价记录。

BuyWhere MCP v2 的 `find_best_price_v2` 与这一任务具有直接对应关系。项目已经围绕该工具完成了：

- 参数契约测试；
- 真实 SG 调用；
- 成功、空结果、退化和失败状态验证；
- 原始记录保留；
- 配件和服务污染准入测试；
- 商家页级报价分组；
- 脱敏 live acceptance。

相比重新选择另一个未经验证的接口，继续使用当前已经形成真实证据的 MCP 工具能够降低首发风险。

### 3.2 MCP 统一外部工具调用协议

MCP 为外部工具提供相对统一的调用形式，包括：

- 工具名称和参数 Schema；
- JSON-RPC 请求与响应；
- 鉴权传递；
- 结构化结果 envelope；
- 错误返回；
- 超时与取消；
- 工具契约演进。

统一协议能够减少每个外部工具都设计一套调用生命周期的成本，但 MCP 不保证业务数据质量。项目仍然必须自行判断 Provider 是否真的成功、结果是否可信以及哪些记录可以发布。

### 3.3 保持领域与 Provider 解耦

业务层依赖项目自己的 `QuoteProvider`，而不是直接依赖 BuyWhere 的工具名和 JSON-RPC 数据结构。

领域端口应表达稳定的业务能力，例如：

```ts
interface QuoteProvider {
  lookup(request: QuoteProviderRequest): Promise<QuoteProviderResult>;
}
```

它不应暴露：

- MCP JSON-RPC 字段；
- `find_best_price_v2` 工具名；
- BuyWhere 原始 envelope；
- REST URL；
- 第三方错误响应结构。

采用该边界后，可以在不改动 Agent 和领域模型的情况下增加：

- `BuyWhereMcpQuoteProvider`；
- `BuyWhereRestQuoteProvider`；
- `InternalCatalogQuoteProvider`；
- `MerchantApiQuoteProvider`；
- `ReplayQuoteProvider`；
- `MultiProviderQuoteAggregator`。

### 3.4 避免模型直接控制外部查询

如果将 BuyWhere MCP 工具直接暴露给模型，模型可能自行决定：

- 查询字符串；
- 是否修改型号；
- 使用哪个市场；
- 调用次数；
- 是否在比较已有结果时重复查询；
- 是否尝试未经批准的搜索模式或 fallback。

当前项目只允许模型提交受限的 `QuoteTurnPlan`，由宿主决定是否调用 Provider。这能够保证：

- 型号未确认时零 Provider 调用；
- 普通比较、聚焦、排除和解释零 Provider 调用；
- 首次报价查询执行一次逻辑调用；
- 只有用户明确刷新才创建新 observation；
- `deliver_to=SG` 固定在 Adapter，模型无法覆盖；
- 型号字母和数字不能被模型静默修改后用于查询。

这种设计把模型限制在意图规划层，把数据访问权限保留在确定性宿主中。

## 4. 当前实现不是“模型直连 MCP”

当前项目的重要实现边界包括：

- `packages/agent/src/schemas.ts`：定义模型能够提交的报价计划；
- `packages/agent/src/quote-turn-agent.ts`：运行受限 Agent Tool 协议；
- `packages/agent/src/quote-turn-executor.ts`：执行审核后的报价操作；
- `packages/runtime/src/quote-provider.ts`：定义领域无关的报价端口；
- `packages/runtime/src/buywhere-mcp-quote-client.ts`：实现 MCP Provider Adapter；
- `packages/runtime/src/buywhere-mcp-quote-parser.ts`：解释 Provider envelope 与状态；
- `packages/runtime/src/quote-lookup-service.ts`：完成报价查询、准入、分组和 FX 投影编排。

外部数据进入用户结果前需要经过：

```text
MCP 原始响应
    ↓
Provider envelope 与状态解析
    ↓
QuoteObservation 原始观测
    ↓
精确型号、限定词和商品角色准入
    ↓
商家页 URL 与成色分组
    ↓
证据投影和宿主确定性回复
```

因此，MCP 响应不是用户事实，也不能由模型直接改写为推荐结论。

## 5. 为什么不直接使用 BuyWhere REST

直接 REST 调用在技术上可行，但不天然优于 MCP。切换到 REST 意味着需要重新承担和验证：

- 请求参数和响应契约；
- 鉴权与限流；
- 分页和结果聚合；
- 错误分类；
- 超时、重试和取消；
- 空结果与退化的区分；
- 实时接口和文档之间的契约漂移；
- REST 与 MCP 返回语义是否一致。

当前已验证的 `find_best_price_v2` 是报价任务，而通用 REST 搜索或 `sort=price_asc` 不一定具有相同业务语义。它们可能返回搜索排序结果，而不是足以支持报价结论的记录。

因此，不应在 MCP 失败时静默切换 REST。否则同一个用户操作可能在不同时间使用不同的数据语义，却仍被发布为同一种 `QuoteLead`。

如果未来证明 REST 在稳定性、覆盖率、成本或字段完整性方面更优，可以实现新的 `QuoteProvider` Adapter，并用相同的契约和真实多用例验收进行显式切换。

## 6. 为什么不直接自建报价数据能力

真正摆脱 BuyWhere 的方式不是重新命名 Agent Tool，而是自建商品与报价数据源。这通常需要：

- 商品知识层；
- 商家 API 接入或网页采集；
- 商品身份和 Variant 匹配；
- 价格、成色和库存记录标准化；
- 报价新鲜度和历史管理；
- 商家页链接治理；
- 数据质量监控；
- 限流、反爬和合规处理；
- 数据源故障和冲突处理。

该方案能够提高长期控制力，但建设和维护成本明显高于当前报价 MVP。只有当以下条件出现时，才值得把它提升为优先事项：

- BuyWhere 覆盖率长期无法达到业务门槛；
- Provider 可靠性严重影响核心用户任务；
- 单次调用成本或配额不可接受；
- 业务需要 BuyWhere 不提供的商品知识或商家数据；
- 多 Provider 聚合能够显著提升报价质量；
- 项目已有足够流量证明自建数据基础设施值得投入。

## 7. MCP 方案的主要风险

选择 MCP 不等于把风险交给协议处理。主要风险包括：

### 7.1 Provider 契约漂移

工具名、参数、envelope 或记录字段可能发生变化。项目必须保存契约 fingerprint，并在解析不到预期结果时发布 `CONTRACT_DRIFT` 或失败状态，不能当作空结果。

### 7.2 外部服务稳定性

真实调用可能出现：

- HTTP 502；
- 超时；
- 限流；
- circuit open；
- 引擎 degraded；
- 返回部分记录但整体状态退化。

所有失败都必须保持为 `DEGRADED` 或 `FAILED`，不能转成“没有报价”。

### 7.3 数据质量不可控

MCP 记录可能包含：

- 配件和服务污染；
- 型号不完整或错配；
- 重复商家页；
- 不同成色；
- 不同币种；
- 不安全或带追踪参数的 URL；
- 过期 availability。

因此必须保留原始 Observation，并在本地执行确定性准入和分组。

### 7.4 外部协议限制业务能力

如果 MCP 工具不提供精确的搜索模式、分页、详情、批量查询或稳定标识，项目不能假设这些能力存在。领域层应把未知保持为未知，而不是由 LLM 或 fallback 填补。

### 7.5 安全与费用控制

如果模型可以直接调用外部 MCP，可能产生重复调用、查询越权和不可控成本。Provider 调用必须受以下机制控制：

- 计划审核；
- 幂等键；
- 单 Turn 调用预算；
- tenant 配额；
- bulkhead；
- circuit breaker；
- lease/fence；
- 超时和取消。

## 8. 三种可选方案比较

| 方案 | 优点 | 缺点 | 当前适用性 |
| --- | --- | --- | --- |
| 模型直接调用 BuyWhere MCP | 集成代码少、演示快 | 查询和事实控制权交给模型，难以保证次数、参数和证据 | 不适合生产主链路 |
| 自定义 Agent Tool + MCP Adapter | 业务边界稳定、外调可控、Provider 可替换 | 需要维护宿主执行器和 Adapter | 当前推荐方案 |
| 自定义 Agent Tool + 自建数据源 | 控制力和可扩展性最高 | 数据、采集、身份和运维成本最高 | 长期条件满足后评估 |

当前项目不应退化为“模型直接调用 MCP”，也不应为了形式上的自主性把已验证的 Provider Adapter 替换成同样依赖外部数据的薄 REST Tool。

## 9. 与商品知识层的关系

商品知识层与 MCP 同样不是互斥选择：

- 商品知识层负责稳定商品身份、Variant、规格、关系和来源；
- MCP Provider 负责动态报价 Observation；
- Agent Tool 负责接受用户意图；
- 宿主策略负责授权、准入、排序和发布。

未来更完整的链路可以是：

```text
用户需求
  ↓
自定义 Agent Tool / 受审计划
  ↓
商品知识层解析 Product 与 Variant
  ↓
Provider Port 请求报价
  ├─ BuyWhere MCP Adapter
  ├─ 商家 REST Adapter
  └─ 内部报价数据源
  ↓
统一 QuoteObservation
  ↓
确定性准入、证据和推荐策略
```

商品知识层不会替代实时报价 Provider，MCP 也不会替代商品知识层。两者分别解决稳定知识和动态外部事实问题。

## 10. 建议与切换条件

### 当前建议

继续保持以下边界：

```text
LLM
  → 自定义计划 Tool
  → 宿主策略与授权
  → QuoteProvider 领域端口
  → BuyWhere MCP Adapter
  → Observation、准入、证据与确定性回复
```

重点加强：

- MCP 契约 fingerprint；
- Provider 状态解析；
- 真实调用可用性指标；
- 调用预算和 circuit breaker；
- 原始 Observation 审计；
- Provider Adapter 替换测试；
- 多 Provider 时的一致语义。

### 评估 REST Adapter 的条件

只有在以下证据成立时再考虑 REST：

- REST 返回字段和状态语义经过真实验证；
- 覆盖率或稳定性显著优于 MCP；
- 具有独立契约测试和故障测试；
- 不依赖静默 fallback；
- 输出仍能映射为相同的领域 `QuoteProviderResult`；
- 用户可见事实边界没有扩大。

### 评估自建数据源的条件

- 已建设 Product/Variant 商品知识层；
- 有稳定、合规的数据获取渠道；
- 可以持续证明新鲜度和身份质量；
- 运营收益能够覆盖采集和治理成本；
- 有多 Provider 或自建数据源的真实对照评测。

## 11. 最终判断

当前使用 MCP 的理由不是“不会自己实现 Agent Tool”，而是：

1. Agent Tool 已由项目自行定义；
2. BuyWhere MCP 是当前报价数据的外部接入协议；
3. `QuoteProvider` 和 Adapter 已经把 MCP 与业务语义隔离；
4. 宿主而非模型拥有查询授权和最终事实；
5. 当前 MCP 路径已有真实验收证据；
6. 未来仍可以在不改变 Agent 合同的情况下切换 REST、增加 Provider 或接入自建数据源。

因此，当前最合理的路线是保留“自定义 Agent Tool + 领域端口 + MCP Adapter”的分层结构，同时持续评估 BuyWhere 的稳定性和覆盖率。只有数据和业务证据证明必要时，才升级为多 Provider 或自建报价基础设施。
