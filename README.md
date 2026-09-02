# RetailPriceAgent

面向新加坡市场、针对已知商品型号的对话式报价线索助手。

用户提供准确型号后，系统通过 BuyWhere MCP v2 `find_best_price_v2` 获取一次报价观测，执行确定性的型号、限定词和主商品角色准入，再按“规范化商家页 URL + 成色”分组。结果是带原币价格、可选 CNY 汇率快照、观测时间和商家入口的报价线索，不是商品推荐、全网最低价、库存或购买保证。

每条可见线索都要求用户在商家页确认最终价格、准确型号/版本、成色与是否可购买。新加坡范围固定在 Provider adapter 内部；产品不会询问或保存配送目的地。

## 架构

```text
React UI
   │ MESSAGE / JWT / SSE
   ▼
Conversation API ─────► PostgreSQL authoritative state
                              │ lease + fence
                              ▼
                    quote-only durable Worker
                              │
                     pi-agent intent planner
                              │ reviewed operations
                              ▼
        exact target policy ─► BuyWhere quote adapter
                              │
             raw observation + admission + grouping + evidence
                              │ atomic publication
                              ▼
                    QuoteLead cards + merchant handoff
```

关键边界：

- 模型只提交受审 `QuoteTurnPlan`；宿主拥有 Provider 调用、状态、事实和最终回复。
- 只有已确认准确型号才能查询；型号字母或数字不会被模糊搜索或模型静默纠正。
- 主链路只调用 `find_best_price_v2`，adapter 内部固定 `deliver_to=SG`；不存在通用搜索或 REST 自动 fallback。
- Provider 状态显式区分 `OK_RESULTS`、`OK_EMPTY`、`DEGRADED` 和 `FAILED`。
- 配件、替换件、维修和服务记录失败关闭，但原始记录与拒绝原因仍保留供审计。
- 原币价格是主要事实；CNY 只在合法 FX snapshot 可用时作为带时间的估算。
- 比较、聚焦、排除和解释复用当前会话已发布观测，零 Provider 调用；只有明确刷新才创建新观测。
- QuoteLeadSet、状态、assistant message 和事件在 PostgreSQL 中按 attempt fence 原子发布。
- 旧推荐合同记录只读，API 返回明确退役边界，活动 Worker 永不领取。

产品合同见 `spec/quote-lead-product-contract.json`。[ADR-0007](docs/adr/0007-singapore-known-model-quote-leads.md) 与 [ADR-0008](docs/adr/0008-maintainable-module-architecture.md) 是现行决策。[已完成阶段](docs/acceptance/completed-phases.md) 只作审批索引。

## 环境要求

- Node.js 22.19+
- npm 11+
- PostgreSQL 16+

本地配置至少需要：

```text
RETAIL_PRICE_DATABASE_URL
RETAIL_PRICE_AUTH_HMAC_SECRET
RETAIL_PRICE_AUTH_ISSUER
RETAIL_PRICE_AUTH_AUDIENCE
RETAIL_PRICE_MODEL_PROVIDER
RETAIL_PRICE_MODEL_ID
RETAIL_PRICE_MODEL_API_KEY
RETAIL_PRICE_PROVIDER_BUYWHERE_API_KEY
```

升级期间仍接受同后缀的 `INTEREC_*` 环境变量；若新旧名称同时存在，以 `RETAIL_PRICE_*` 为准。数据库迁移会将旧 Schema 原位改名，不复制或丢弃既有数据。

安装、迁移和启动：

```powershell
npm ci
Copy-Item .env.example .env
npm run db:migrate

# 三个终端
npm run dev:api
npm run dev:worker
npm run dev --workspace frontend
```

默认前端为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:8081`。

## 验证

默认 acceptance 只验证当前报价产品，并包含产品合同、漂移、文档、lint、单实现架构、维护性、类型、覆盖率、真实 PostgreSQL 集成、Chromium E2E 和生产构建：

```powershell
npm run acceptance
```

常用分项：

```powershell
npm run quote:contract:check
npm run quote:drift:check
npm run architecture:active:check
npm run architecture:maintainability:check
npm run test:unit
npm run test:integration
npm run test:e2e
```

真实 BuyWhere 验收会产生外部调用，必须显式授权；报告会脱敏且不保存 API key：

```powershell
$env:RETAIL_PRICE_QUOTE_LIVE_ACCEPTANCE_CONFIRM='authorized-buywhere-multi-case-read'
npm run quote:live:acceptance
```

实时目录会变化，因此具体结果数量不是永久门槛。门槛是：调用工具与 SG 范围正确、Provider 状态解释正确、身份准入失败关闭、证据完整，以及用户回复没有未经证实的推荐、最低价、库存、配送或可购买承诺。

## 项目结构

```text
packages/domain/      纯领域合同；对话类型、状态、发布校验、准入、分组和计划策略按变化原因拆分
packages/agent/       独立 prompt、单工具协议、pi-agent 单轮 runner、确定性执行器和宿主回复渲染
packages/runtime/     Worker 租约循环与单轮 runner；PostgreSQL 门面与聚焦 stores；BuyWhere、FX 和证据持久化
packages/api/         44 行 composition root；REST routes、SSE routes、错误映射和 projection
frontend/             HTTP/SSE wire contract、会话 controller、展示格式化和 React 组件
spec/                 机器可读产品合同与阶段状态
docs/                 ADR、执行计划和阶段审批证据
scripts/              漂移、架构、质量门禁和受控 live 验收
```

活动代码依赖固定为 `domain ← agent ← runtime ← api`；前端不导入后端工作区，只消费 HTTP/SSE wire contract。`domain`、`agent` 和 `runtime` 仅提供显式根导出，SQL store、工具协议和 runner 等实现细节不进入公共 API。架构检查会拒绝反向依赖、跨包深层导入、根入口通配导出、退役脚本和无源码的构建残留。
