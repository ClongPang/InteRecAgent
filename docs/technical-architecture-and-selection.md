# InteRecAgent 技术架构与技术选型

**版本**：1.1
**日期**：2026-08-15
**项目**：InteRecAgent
**文档类型**：技术架构、选型与可靠性基线

## 1. 目的与边界

本文将产品需求转化为可实施的技术架构，覆盖对话式推荐、跨平台商品检索、人民币估算、证据追溯、异常处理与渐进式交付。

InteRecAgent 是跨平台跨境购物研究员和购买决策助手，不是支付、下单、代购、物流或订单系统。人民币价格用于统一比较，不应被表述为最终到手价；运费、税费与配送能力必须以可验证数据为准。

商品供应商以 BuyWhere 为首期来源，但其公开页面、MCP 指南、插件 Manifest 与 OpenAPI 的能力描述存在差异。因此本文将在线 OpenAPI 和持有真实 API Key 后的实测响应作为接口契约依据；营销覆盖数据、未出现在 OpenAPI 中的字段或 MCP 示例参数均不构成产品承诺。

## 2. 架构结论

采用**状态机驱动的单领域 Agent**：由一个以 `ShoppingMission` 为中心的编排器驱动多个职责清晰的节点，而不是一开始部署多个可自由互聊的自主 Agent。

该选择的原因：

- 购物任务的难点是持续维护约束、候选、证据和版本，而不是生成更多观点。
- 商品价格、库存、规格与汇率是高风险事实，必须通过受控工具和确定性代码处理。
- 用户会在同一任务中反复修改预算、用途和偏好；系统需要只重算受影响的阶段。
- 推荐结果需要可复现、可解释、可审计，且能处理部分数据可用的情况。

### 2.1 总体架构

```text
React 任务工作区
  │ REST 命令 / SSE 事件流
  ▼
FastAPI BFF
  ├─ 鉴权、输入校验、任务 API、流式输出
  └─ 任务编排入口
       ▼
Shopping Mission Orchestrator（LangGraph）
  ├─ 意图/约束解析               LLM + 结构化输出
  ├─ 状态合并与版本控制           确定性代码
  ├─ 追问决策与暂停恢复           规则优先
  ├─ 查询规划                     LLM 生成受限工具参数
  ├─ 商品/汇率数据接入            服务端 Adapter
  ├─ 归一化、去重、硬过滤、排序    确定性代码
  ├─ 证据校验                     确定性代码
  └─ 推荐解释                     LLM，仅引用已有证据
       │
       ├── PostgreSQL：任务、事件、证据、决策快照
       ├── Redis：缓存、分布式限流、幂等锁、队列 Broker
       └── Celery Worker：价格刷新、提醒、异步重试
```

### 2.2 事实、决策与语言的职责分离

| 层 | 职责 | 禁止事项 |
|---|---|---|
| 事实层 | 保存 BuyWhere 与汇率接口返回的原始/标准化快照 | 让 LLM 填补缺失价格、库存或规格 |
| 决策层 | 硬约束过滤、同款识别、评分、排序、置信度计算 | 将最终判断完全交给模型 |
| 语言层 | 理解意图、生成追问、解释权衡 | 生成未被证据支持的商品断言 |

LLM 只能提出查询计划、结构化的约束变更和解释草案；外部访问、事实读取、排序和响应渲染均由后端控制。

### 2.3 BuyWhere 接入边界（经公开接口复检）

当前在线 OpenAPI 已确认的 REST 路径包括商品搜索、详情、2–10 件商品比较、最长 90 天价格历史、优惠商品与分类浏览；搜索参数已公开 `q`、`domain`、`region`、`country_code`、原币种价格范围、`currency`、`compact`、分页及 `keyword` / `semantic` / `hybrid` 模式。[BuyWhere OpenAPI](https://api.buywhere.ai/openapi.json)

首期只能将下列市场作为**已公开契约的候选商品市场**：`SG`、`US`、`VN`、`TH`、`MY`。`country_code` 不等于配送目的地，`region` 文本中即使出现其他区域，也不构成相应国家有可用商品数据的保证。

生产链路采用 **BuyWhere REST Adapter 优先**；MCP 仅用于原型、开发调试或验证 MCP-only 能力。原因是 REST OpenAPI 是当前可版本化的正式参数契约，而 MCP 指南示例中的 `country` 与 REST 的 `country_code` 不一致，且指南列出的 `find_best_price` 在当前 REST OpenAPI 中没有对应路径。[BuyWhere MCP Guide](https://api.buywhere.ai/docs/guides/mcp)

插件 Manifest 宣称 `deliver_to`、配送可用性标签与 `include_unshippable` 等能力，但这些参数和字段未出现在当前搜索 OpenAPI 中。[BuyWhere Plugin Manifest](https://api.buywhere.ai/.well-known/ai-plugin.json) 因此，MVP 不得以 BuyWhere 数据宣称商品可配送到中国大陆或进行“可直邮”排序；配送状态默认 `unknown`，只允许在商户页由用户核验。

## 3. Agent 运行模型

### 3.1 任务状态

`ShoppingMission` 是任务唯一事实入口，而不只是消息列表。至少包含：

```text
mission_id、title、stage、constraints、constraints_version、
message_timeline、search_plan、product_evidence_snapshot_ids、
fx_snapshot_ids、candidate_set_id、comparison_set、
recommendation_run_id、merchant_clicks、created_at、updated_at
```

用户输入不直接覆盖任务状态，而是先被解析为 `IntentPatch`。例如“预算改成 2,000，更重续航”应成为：

```json
{
  "budget_cny": 2000,
  "preference_patch": { "battery_weight": "higher" }
}
```

系统将该变更追加为事件、递增 `constraints_version`，并根据依赖关系使缓存失效：预算和偏好通常只需重跑过滤、排序和解释；商品检索或汇率尚未过期时不应重复请求。

### 3.2 状态图

```text
receive_message
  → validate_input
  → parse_intent_patch
  → merge_mission_state
  → need_clarification?
      ├─ 是：ask_one_question → wait_for_user
      └─ 否：build_search_plan
            → fetch_products ─失败→ cached_or_partial_products
            → fetch_fx ───────失败→ native_currency_only
            → normalize_and_deduplicate
            → filter_hard_constraints
            → rank_candidates
            → verify_evidence
            → compose_recommendation
            → persist_decision_snapshot
            → stream_result
```

追问只在缺失信息会显著影响排序或硬约束时发起，且每次仅询问一个问题。对话、候选、比较和详情页面共享同一 `mission_id` 与状态版本。

### 3.3 推荐与证据契约

模型输出的是草案，而不是可直接展示的商品事实：

```text
RecommendationDraft
├─ primary_product_id
├─ alternative_product_ids
├─ rationale
├─ tradeoffs
└─ cited_evidence_ids
```

后端验证所有商品 ID 与证据 ID 后，从 `ProductSnapshot` 和 `FxSnapshot` 重新取出价格、库存、规格、链接和更新时间，构造最终 `RecommendationResponse`。不存在证据的断言必须删除或降级为不确定描述。

## 4. 数据设计

| 实体 | 主要内容 | 设计目的 |
|---|---|---|
| `shopping_missions` | 当前条件、阶段、版本 | 恢复同一购物任务 |
| `mission_events` | 输入、条件修改、撤销、选中比较、跳转 | 可回放、可解释变更 |
| `product_snapshots` | 原始响应、标准化字段、获取时间、来源、Adapter/契约版本 | 保存可追溯商品事实并定位供应商字段变更 |
| `fx_snapshots` | 汇率、来源、时间、有效期 | 解释人民币估算依据 |
| `candidate_sets` | 候选、过滤原因、评分、排序 | 重现某轮选择 |
| `recommendation_runs` | 首选、备选、证据、模型/提示词版本 | 审计模型输出 |
| `comparison_sets` | 用户加入的比较集合 | 在页面切换后保留比较上下文 |
| `outbox_events` | 待处理提醒、刷新和审计事件 | 可靠触发异步任务 |

业务事实源为 PostgreSQL。LangGraph checkpoint 仅用于保存图的执行位置和暂停/恢复上下文，不能替代上述业务记录。

## 5. 技术选型

| 层级 | 选型 | 理由 | 使用边界 |
|---|---|---|---|
| 前端 | React、TypeScript、Vite；TanStack Query | 与现有代码一致；适合任务视图、缓存与服务端状态同步 | 仅保存临时 UI 状态，任务事实留在后端 |
| API | FastAPI、Pydantic v2、httpx、Tenacity | Python 生态与现有项目一致；适合并发调用商品和汇率接口；类型验证贯穿请求/响应 | 所有密钥与第三方调用只在服务端 |
| 商品数据 | BuyWhere REST Adapter；MCP Adapter（可选） | REST OpenAPI 是首期参数契约；用 Adapter 屏蔽 `country_code`、响应容器及字段变化 | 不让领域层或 LLM 直接依赖 BuyWhere 原始字段；MCP-only 功能须实测后启用 |
| Agent 编排 | LangGraph（Python） | 支持状态图、检查点、流式输出、暂停/恢复与失败路由，适合长生命周期购物任务 | 不作为业务数据库，不允许节点绕过领域服务 |
| LLM | OpenAI Responses API，结构化输出与函数工具 | 以 Schema 限制意图解析、搜索计划和解释草案；工具由后端执行 | 不直接信任模型生成的商品事实 |
| 决策模块 | 自研 Python 规则与评分引擎 | 硬约束、价格换算、排序需稳定、可测试、可复现 | LLM 只可辅助解析低置信度规格 |
| 数据库 | PostgreSQL、SQLAlchemy 2、Alembic | 任务/事件/快照需强关系和事务；JSONB 可保存原始 API 证据 | 先不引入向量库作为核心依赖 |
| 缓存与保护 | Redis | 搜索/汇率缓存、分布式限流、幂等锁、队列 Broker | 缓存可失效，不保存唯一业务事实 |
| 异步任务 | Celery、Redis、Celery Beat | 适合价格监测、刷新、重试和提醒等跨进程任务 | MVP 不使用 FastAPI 进程内后台任务处理关键任务 |
| 可观测性 | OpenTelemetry、Sentry、结构化日志 | 关联 `mission_id`、`run_id`、`trace_id`，定位模型和上游异常 | 日志需脱敏，不记录 API Key 与不必要个人数据 |
| 测试 | pytest、respx、Adapter 契约测试、Playwright | 覆盖 Adapter 字段差异、故障降级和端到端任务连续性 | 对真实 API 使用受控冒烟测试；将脱敏响应保存为 fixture |

LangGraph 的持久化与 interrupt 机制适合用户补充关键条件后从同一任务恢复；生产环境需要持久化 checkpointer。[LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

FastAPI 适合商品、汇率等 I/O 密集型并发请求；同步与异步依赖可组合使用。[FastAPI Async](https://fastapi.tiangolo.com/async/)

BuyWhere 返回的是商品原币种价格；其公开 MCP 指南将 `normalized_price_usd` 定位为静态、近似的跨币种粗排字段，不能作为用户展示或结算金额。因此人民币估算必须由独立 FX Adapter 计算、加时间戳并保存快照。[BuyWhere MCP Guide](https://api.buywhere.ai/docs/guides/mcp)

## 6. 异常处理与降级策略

### 6.1 统一错误契约

所有 Adapter、模型调用和决策节点返回标准错误对象：

```text
error_code、category、retryable、degraded_result_available、
affected_evidence_ids、retry_after、user_message、trace_id
```

其中 `category` 为 `user`、`upstream`、`model`、`data`、`system` 或 `security`。前端依据错误类别显示可执行的恢复动作，不暴露密钥、内部堆栈或原始上游错误。

### 6.2 异常矩阵

| 场景 | 后端策略 | 用户结果 | 技术保障 |
|---|---|---|---|
| BuyWhere 超时或 5xx | 有限重试、熔断、读取未过期缓存 | 使用最近可用候选并标注更新时间，或明确无法实时检索 | httpx 超时、Tenacity、Redis 缓存、Circuit Breaker |
| BuyWhere 429 | 遵守 `Retry-After`、平台/API Key 限流、请求去重 | 避免重复检索；保留已有候选 | Redis 令牌桶/滑动窗口、幂等锁 |
| 鉴权失败 | 不重试；告警并隔离密钥 | 服务配置异常，不泄露密钥 | Secret 管理、错误映射 |
| API 字段漂移或字段缺失 | Pydantic 契约校验；可选字段降级 | 显示“库存/规格暂未提供”，不补写事实 | Adapter Anti-Corruption Layer、契约测试 |
| 文档、MCP 与 OpenAPI 能力不一致 | 以已验证 REST 契约为准；隔离未验证功能开关 | 不展示未证实的功能或结论 | Capability Manifest、供应商准入测试 |
| `deliver_to` / 配送标签未验证 | 不将其传入生产查询，也不参与排序 | 配送状态为“待商户页确认” | 显式 `unknown` 状态、商户跳转提示 |
| 汇率不可用 | 不计算或排序人民币价；保留原币 | 显示原币与人民币估算不可用 | 独立 FX Adapter、FX Snapshot |
| 数据过期 | 新鲜度评分下降；需要时触发刷新 | 明确展示更新时间 | `updated_at`、TTL、freshness score |
| LLM 非法结构 | Schema 验证；最多一次格式修复；随后模板化回复 | 安全、简短的降级说明 | Pydantic、限制重试次数 |
| LLM 无依据断言 | 校验证据 ID；删除不支持的断言 | 仅返回可验证理由 | Evidence-first response contract |
| 用户修改条件时旧任务返回 | `constraints_version` 比较；旧结果禁止提交 | 仅显示最新条件的结果 | 乐观并发控制、取消令牌 |
| SSE 断线或页面刷新 | 客户端携带 `mission_id` 和最后事件 ID 重连 | 恢复同一任务、候选与比较集 | 事件持久化、SSE 重连 |
| 价格提醒重复投递 | 幂等键、Outbox、消费确认 | 同一价格变化只提醒一次 | PostgreSQL 事务、Celery 重试 |
| 提示注入或恶意商品文本 | 将所有外部文本视为不可信输入；工具白名单 | 不改变工具权限与系统规则 | 输入隔离、参数校验、审计 |

### 6.3 部分成功是正常结果

搜索成功但汇率失败、部分平台限流、详情缺失等不应被视为整轮任务失败。系统应返回可用的商品原币信息、明确缺失字段、数据新鲜度和下一步动作，而不是伪造完整结果。

## 7. 缓存、限流与幂等性

- 汇率使用短 TTL 缓存，同时保存长期 `FxSnapshot` 以解释历史人民币估算。
- 搜索缓存键包含商品查询、已验证的 `country_code`、平台、搜索模式、约束版本和查询计划指纹；不使用“全球覆盖”或未验证配送字段作为查询假设。
- 同一 `mission_id + constraints_version + search_plan_hash` 使用幂等锁，避免重复调用上游。
- 以用户、任务、平台、模型和 API Key 为维度设置请求预算；429 后自动退避。
- 缓存只优化性能，PostgreSQL 中的证据快照才是唯一可审计事实。

多实例部署必须使用共享限流状态；Redis 可实现令牌桶、滑动窗口和原子计数等模式。[Redis Rate Limiting](https://redis.io/docs/latest/develop/use-cases/rate-limiter/)

## 8. 异步任务边界

FastAPI `BackgroundTasks` 只用于非关键、短时操作，例如附加审计日志。价格关注、周期刷新、提醒投递、长时间退避重试需要 Celery Worker 执行，防止 Web 进程重启导致任务丢失。FastAPI 官方也建议对重型、跨进程任务使用具备队列能力的工具。[FastAPI Background Tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)

如后续价格跟踪发展为核心服务，出现跨天等待、复杂审批或高可靠编排需求，再评估引入 Temporal；MVP 不提前承担其部署与运维成本。

## 9. 安全与隐私

- BuyWhere、汇率和模型 API Key 仅保存在服务端 Secret 管理中。
- 外部商品描述、商户 URL、用户粘贴文本均视为不可信输入。
- 商户跳转仅允许来自已验证商品快照的 HTTPS URL，并显示真实域名；是否能配送到用户目的地以商户页为准。
- LLM 工具采用显式 allowlist、强类型参数和服务端授权，不允许模型选择任意 URL。
- Trace 与日志默认脱敏；不记录密钥、支付信息及非必要的用户身份数据。
- 推荐结果必须携带证据引用；没有证据不得声称可配送、正品、保修、最终费用或售后政策。

## 10. 评测与验收

### 10.1 必测故障场景

1. 401、404、429、5xx、超时、空结果与字段缺失。
2. 搜索成功但汇率失败，仍能安全返回原币结果。
3. 用户连续修改预算时，旧检索结果不覆盖新版本。
4. 页面刷新、SSE 中断后，任务、候选和比较集合可恢复。
5. LLM 输出无效 JSON、错误商品 ID、虚构价格或不存在规格时被阻断。
6. 异步提醒任务重试后不重复通知。
7. 商品同名但型号、套装或容量不同，不被错误归为同款。
8. `deliver_to`、`availability`、`include_unshippable` 等未出现在 REST 契约中的能力不得被调用或展示为已支持。
9. BuyWhere MCP 与 REST 参数不一致时，REST Adapter 使用经实测的参数映射，且 MCP 功能被单独隔离。

### 10.2 核心指标

- 推荐字段证据可追溯率：100%。
- 硬约束违反率：低于 3%。
- 价格、库存、商户信息无依据陈述率：0。
- 已缓存搜索 P95：低于 1 秒；首次搜索 P95：低于 3 秒。
- 上游错误均有分类、可观测 trace 和用户可理解的降级结果。
- 供应商声明的市场、平台、配送字段均以每次实际响应和准入报告为准，不以营销页面统计值作为产品指标。

### 10.3 BuyWhere 供应商准入测试

在持有真实 API Key 后、实现依赖该供应商的产品功能前，必须完成下列测试并保留脱敏报告：

1. 分别对 `SG`、`US`、`VN`、`TH`、`MY` 搜索，记录实际商品量、平台、原币种、`data/meta` 容器与字段缺失率。
2. 验证 `country_code`、`currency` 与 `min_price/max_price` 的原币种语义；人民币预算必须先由 FX 模块换算后再检索。
3. 用搜索返回的真实 ID 验证详情、比较及 30/90 天价格历史接口。
4. 验证 `compact` 模式、`structured_specs`、`comparison_attributes`、库存和 `updated_at` 的真实结构，确认前端字段白名单。
5. 通过 MCP `tools/list` 与 `tools/call` 单独验证 `country`、`find_best_price`、`deliver_to` 等能力；未通过时不进入生产功能。
6. 验证 401、404、429、5xx、超时和空结果的真实响应、重试边界与 `Retry-After` 行为。
7. 使用 30–50 个真实购物任务形成市场/品类覆盖评测集，形成上线基线；不得以“300M+ 商品”或“全球配送”等供应商宣传指标替代。

## 11. 交付顺序

1. 使用真实 Key 完成 BuyWhere 供应商准入测试，冻结首期可用市场、字段白名单和 REST 参数映射。
2. 建立 PostgreSQL 任务、事件、商品快照和汇率快照模型。
3. 实现 BuyWhere REST/汇率 Adapter、超时、重试、缓存、错误分类与契约测试；MCP 能力在独立 feature flag 下接入。
4. 实现确定性的硬过滤、去重、评分和排序，并保存候选决策快照。
5. 接入 LLM 的结构化意图解析、单问题追问和证据约束的解释生成。
6. 引入 LangGraph 状态图、检查点、SSE 进度和任务恢复。
7. 增加 Celery 价格关注、提醒、观测、故障注入和离线评测。

这一顺序先把事实与决策链路做可靠，再增强自然语言能力；即使模型或外部服务异常，系统也能保守、透明且可恢复地工作。
