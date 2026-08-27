# InteRecAgent：基于 pi-agent 的对话式推荐 Agent 完整重构方案

> 状态：多方审批通过，可进入实施；不代表生产发布批准
> 日期：2026-08-26
> 决策类型：产品模型、Agent 运行时、数据模型和前端工作台整体重构
> 约束：不建设兼容层、不双写、不保留两套主动实现；以业务产品目标和可验证用户行为为唯一收敛标准

## 1. 执行结论

InteRecAgent 的目标产品不是“输入一句自然语言，等待一次推荐结果”，而是一个以选购任务为生命周期、能围绕同一候选世界持续交互的对话式推荐 Agent。

本次重构采用以下总决策：

1. pi-agent 成为每个用户话轮的认知、计划和受限工具编排核心。
2. Conversation 是长期业务边界；Turn 是一次 durable 执行边界。Turn 终结不等于 Conversation 终结。
3. 模型负责理解开放语言、形成 TurnPlan、选择受限工具和提交 AssistantEnvelope；确定性代码负责事实、金额、证据晋级、过滤、排序、引用验证和最终持久化。
4. `ShoppingGoal + GoalOperations` 是购物目标的唯一写权威。
5. `WorkingSet` 是对话可指代、可筛选、可比较的候选世界；`ComparisonSet` 是其中经 proof gate 晋级的可比较切片，不再承担整个对话状态。
6. 普通问答、澄清、条件修改、排除、重排、比较和解释不得默认触发外部检索。
7. 保留当前 TypeScript 版 durable worker、proof-carrying 报价内核、Provider adapter 和遥测能力；重写当前单轮 pi-agent 协议、会话数据模型、API 投影和前端。
8. 迁移完成后删除当前单轮入口与过时文档；不保留 runtime flag、兼容 DTO、旧 API 或双写路径。

## 多方审批讨论与裁决

### 产品与对话体验审批

**当前 V2：REJECT。目标方案：满足轨迹门槛后 APPROVE。**

产品方认为多轮对话是 P0，不是后续增强。Conversation/Mission 必须长期存在；用户必须能澄清、追问、指代、比较、拒绝、纠错、修改条件和撤销。页面必须恢复消息时间线和持续候选工作区。单次 live run 或一次 Decision 不能证明对话产品完成。

### pi-agent 运行时架构审批

**当前 research-only 三工具协议：REJECT。Conversation Turn Runtime：APPROVE FOR IMPLEMENTATION。**

架构方要求每个 attempt 创建 fresh Pi Agent，但跨轮状态必须来自不可变 ConversationSnapshot。Agent 执行 Observe/Plan/Execute/Answer；先提交多操作 TurnPlan，再按阶段动态暴露 WorldOp，最后发布 AssistantEnvelope。模型拥有语言理解和表达组织权，但没有事实创造、状态提交或任意外调权。

### 可靠性、数据、安全与发布审批

**当前整体：REJECT。纯领域方向：CONDITIONAL APPROVE。**

可靠性方指出当前会提前发布 Goal/ComparisonSet、过期 lease 仍可能提交、事件序号存在并发风险、身份头可伪造、outbox 和 migration 只是名义能力、proof chain 不完整。外调只能承诺 at-least-once；Conversation revision、AssistantMessage、Goal、WorkingSet、Decision 和事件必须 exactly-once publication。

### 争议与最终裁决

| 争议 | 方案 A | 方案 B | 裁决 |
|---|---|---|---|
| 自然表达与事实安全 | 模型直接写完整答案 | 全模板回复 | 使用 AssistantEnvelope：模型组织 discourse，事实只由 verified claim block 渲染 |
| 新消息打断运行 | 无条件 latest-message-wins，只取最后一句 | 严格 FIFO，不能纠正正在运行的任务 | 允许 interrupt/supersede，但下一 Turn 必须按序消费自上次已提交 AssistantMessage 后的全部未消费 USER 消息 |
| Agent 记忆 | 持久化 pi transcript | 只传当前一句 | PostgreSQL 保存业务状态；每 attempt 从 revision 构造有界 ConversationSnapshot |
| proof-carrying 保留范围 | 原样保留现实现 | 全部推倒 | 保留类型化证据方向和已验证纯函数；重写 claim/FX FK、promotion、TTL 和 final verifier |
| 迁移策略 | 旧/新双写兼容 | 直接清空一切 | 不兼容、不双写；归档必要审计数据，重建正式 schema，单实现切换 |
| SSE 内容 | 直播模型草稿 | 只在最后返回 | 流式进度和已验证 blocks；未经验证的商品事实永不出站 |

总裁决：**当前 V2 不批准继续补丁式演进；本文目标架构批准进入实施，但不等于生产批准。**

## 2. 产品目标与边界

### 2.1 产品承诺

用户能够在同一个选购任务中完成：

- 用自然语言描述商品、型号、用途、预算、市场、库存偏好和排除条件；
- 在信息不足时只回答一个高影响澄清问题，然后继续同一任务；
- 查看 US/SG 的可追溯报价、原币金额和带快照的人民币估算；
- 追问“为什么推荐它”“第二个怎么样”“美国有货的吗”；
- 修改预算、市场、型号、成色或库存偏好；
- 排除、恢复、聚焦和比较当前候选；
- 撤销最近一次条件变更；
- 刷新页面或服务重启后恢复消息、条件、候选和进度；
- 在证据不足时得到明确的未知、澄清、无匹配或降级说明，而不是幻觉答案。

### 2.2 非目标

- 不做通用闲聊机器人；非购物话题简短说明边界。
- 不承诺支付、下单、配送资格、关税、运费、保修、真伪或全网最低价。
- 不让模型直接决定金额、资格、排序、库存或可引用商品。
- 不把完整历史 transcript 无界塞入模型。
- 不为旧 Python runtime、旧 API 或当前错误的单轮 V2 保留兼容层。

### 2.3 北极星行为指标

- 多轮任务完成率；
- 澄清后继续率和单任务澄清轮数；
- 无必要 Provider 调用率；
- 指代解析正确率；
- 条件修改/撤销正确率；
- grounded claim 有效率；
- 推荐集合外引用数；
- 每个完成任务的模型与 Provider 成本；
- Turn P50/P95/P99 与 Conversation 成功率。

## 3. 当前实现的偏差结论

当前 TypeScript V2 已具备可靠底座，但产品层存在结构性偏差：

| 维度 | 原业务目标 | 当前实现 | 结论 |
|---|---|---|---|
| 生命周期 | 一个 Mission/Conversation 多轮推进 | 每条消息产生一次推荐 run | 重写 |
| Agent | 每轮判断谈、问、改、滤、排、搜 | `commit_turn → discover/inspect` | 重写 |
| 状态 | Goal + WorkingSet + DialogueState + Thread | Goal + 最新 ComparisonSet | 扩展并重构 |
| 澄清 | Assistant 追问，等待用户继续 | `CLARIFICATION` Decision 终态 | 重写 |
| 普通问答 | 读取当前世界，零外调回答 | 没有独立 talk/answer 路径 | 新建 |
| 前端 | 对话线程 + 条件栏 + 候选工作区 | textarea + 一次性结果 | 重写 |
| 证据内核 | 确定性事实与引用 | proof-carrying pipeline | 保留并扩展 |
| durable worker | 每轮可恢复、可 fencing | 已实现 | 保留 |
| 可观测性 | run/model/tool/provider 可关联 | 已实现 Langfuse/OTel | 保留并增加对话指标 |

### 3.1 可靠性与证据底座并非无条件通过

独立审计还发现当前底座必须同步重写的问题：

- `commitGoal`/`saveResearchWave` 在 Turn 成功前就写入 conversation-scoped “latest”，失败、取消或 superseded attempt 可能污染下一轮；
- `completeRun` 没有强制 lease 尚未过期，未被新 worker 接管的过期 worker 仍可能提交；
- 事件使用 `MAX(seq)+1`，并发 cancel/worker 可能撞唯一键；
- idempotency key 重用没有校验 canonical payload hash；
- 工具回执不是调用前 durable，崩溃后外调可能重复且没有 stable step key；
- outbox 只有写入，没有 publisher、重试或积压处理；
- migration runner 没有 checksum、advisory lock 和 schema drift verifier；
- 浏览器可直接伪造 tenant/actor header，不能作为生产身份边界；
- proof-carrying 仍缺少“输出 claim → source fact → artifact/FX snapshot”的完整数据库约束和最终 verifier；
- artifact `expires_at` 没有清理器和来源条款驱动的保留策略。

因此批准保留的是设计资产和纯领域逻辑，不是现有 repository、schema 和运行行为。

## 4. 目标架构

```text
React Conversation Workspace
  ├─ Thread / Composer / Clarification
  ├─ Goal & condition chips
  └─ WorkingSet / Compare / Evidence drawer
                 │ HTTP command + resumable SSE
                 ▼
Fastify Conversation API
  ├─ append user message + create durable Turn
  ├─ conversation projection query
  └─ event stream / cancel / undo
                 │
                 ▼
PostgreSQL authoritative ledger
  ├─ Conversation / Messages / Turns / Events
  ├─ GoalVersions / GoalOperations / DialogueState
  ├─ WorkingSets / Mentioned / Focus
  ├─ Research / Artifacts / Qualifications / ComparisonSets
  └─ AssistantResponses / Decisions / ToolReceipts / Outbox
                 │ claim + lease + fence
                 ▼
Durable Turn Worker
                 │ hydrate bounded ConversationContext
                 ▼
pi-agent Turn Orchestrator
  ├─ commit_turn_plan
  ├─ dynamic WorldOps（一次只暴露下一个合法工具）
  └─ publish_reply
                 │
                 ▼
Deterministic host services
  ├─ Goal reducer / referent binder / conversation policy
  ├─ BuyWhere + FX
  ├─ proof-carrying qualification / ranking
  ├─ ClaimVerifier / renderer
  └─ atomic Turn commit
```

## 5. 包与职责边界

### `packages/domain`

保留并扩展为无 I/O 的确定性业务内核：

- `ShoppingGoal`、`GoalOperation` 和 reducer；
- 版本化 CategoryContract/MarketContract 与 typed spec policy；
- 商品身份、金额、汇率、证据和 proof-carrying 资格；
- `WorkingSet`、绑定、过滤、排除、重排和比较；
- `ComparisonSet`、Decision 和 ClaimLedger 校验；
- AssistantEnvelope 验证与结构化渲染。

### `packages/agent`（新增）

只负责 pi-agent 适配和话轮认知协议：

- `ConversationContext` 投影；
- system prompt 与 tool schemas；
- `TurnPlan`、`AssistantEnvelope` schema；
- Agent phase machine、tool budget、取消和事件映射；
- 模型输出的结构校验与自纠；
- 不访问 PostgreSQL，不直接调用 Provider。

### `packages/runtime`

负责应用编排与基础设施：

- durable Turn worker；
- Conversation/Turn repository 和事务；
- Agent tools 的宿主实现；
- Provider、Research、Telemetry、Outbox；
- 把 Agent proposal 交给 domain 校验并原子提交。

### `packages/api`

仅负责身份、HTTP/SSE 契约和错误映射；不包含对话策略。

### `frontend`

只消费 ConversationProjection 和事件，不自行推导业务终态，不用“Decision 404”判断任务进度。

## 6. Conversation、Turn 与状态模型

### 6.1 Conversation

Conversation 表示一次持续选购任务，状态为：

```text
OPEN ── user closes ──> CLOSED
  └── fatal policy/security violation ──> BLOCKED
```

澄清、无匹配、Provider 失败和单轮取消都不会关闭 Conversation。

### 6.2 Turn

每条用户消息创建一个 durable Turn：

```text
ACCEPTED → CLAIMED → RUNNING → COMMITTING → COMPLETED
                  ├──────────→ FAILED
                  ├──────────→ CANCELLED
                  ├──────────→ TIMED_OUT
                  └──────────→ SUPERSEDED
                                  └─ attempts exhausted → DEAD_LETTER
```

`COMPLETED` 只表示本轮助手响应已持久化。澄清、普通回答、推荐、无匹配和降级都是 `TurnOutcome`，不是基础设施状态；澄清回复也是一个成功完成的 Turn。

### 6.3 权威状态

```ts
interface ConversationState {
  revision: number
  goal: ShoppingGoal | null
  goalVersion: number
  dialogue: {
    pendingClarification: ClarificationRequest | null
    pendingOps: WorldOp[]
    focusRefs: string[]
    lastAssistantMessageId: string | null
  }
  workingSet: {
    version: number
    pool: CandidateRef[]
    display: CandidateRef[]
    mentioned: CandidateRef[]
    comparison: CandidateRef[]
  }
}
```

完整消息账本是审计和 UI 数据，不直接等同于模型上下文。消息角色只保留 `USER | ASSISTANT`；系统事件进入独立 `conversation_events`，避免 thread 与 event 成为双权威。

`ShoppingGoal` 不再是 query/market/budget 的耳机专用 DTO：

```ts
interface ShoppingGoal {
  target: {
    categoryId: string
    canonicalModel: string | null
    itemRole: 'PRIMARY_PRODUCT' | 'ACCESSORY' | 'REPLACEMENT_PART' | 'BUNDLE' | 'SERVICE'
    condition: 'NEW' | 'REFURBISHED' | 'USED' | 'ANY'
  }
  hardConstraints: Constraint[]
  preferences: Preference[]
  retrievalScope: { markets: string[] }
  deliveryDestination: string | null
  budget: { amount: string; currency: string } | null
  stockPreference: 'ANY' | 'KNOWN_IN_STOCK'
  exclusions: EntityRef[]
  unresolved: GoalGap[]
}
```

检索市场和配送目的地必须分离；Provider market 不能提升为配送资格。所有 Goal 修改使用有来源 turn/span 的 `GoalOperation`，支持 set/retract/correct/undo 和冲突检测。

品类和市场通过版本化 `CategoryContract`/`MarketContract` registry 发布。首个正式垂直切片至少覆盖 headphones 与 smartphone；US/SG 为首发市场，VN/TH/MY 作为后续 contract 发布，不在核心类型中硬编码。删除当前 `ProductCategory = HEADPHONES | UNKNOWN` 的架构限制，也不建设无边界通用 ontology。

## 7. TurnPlan 与对话策略

### 7.1 TurnPlan

一个话轮可以包含多个有序操作：

```ts
interface TurnPlan {
  ops: TurnOperation[]
  leftover: PendingOperation[]
  userIntentSummary: string
}
```

`TurnOperation` 是 GoalOperation、WorkingSet operation、evidence answer operation、clarification 或 research operation 的联合类型。禁止把它拆成会丢失相对顺序的多个数组，也禁止重新退化成单个 `kind → route`。宿主根据有序操作和当前世界编译执行策略。

### 7.2 WorldOp

- `focus(ref)`；
- `reject(ref, reason)` / `restore(ref)`；
- `filter(predicate)`；
- `rerank(preference)`；
- `compare(refs)`；
- `inspect(refs, fields)`；
- `undo(operationId)`；
- `clear_focus`。

所有引用先通过 WorkingSet binder。绑定失败必须追问或明确说无法对应，禁止回落到 rank 1。

### 7.3 Research policy

| 用户行为 | Provider 调用 |
|---|---:|
| 问当前候选价格/平台/库存/原因 | 0 |
| 比较当前候选 | 0 |
| 排除、恢复、软偏好、重排 | 0 |
| 收紧且现有池可回答的条件 | 0 |
| 新商品/型号、市场变化、预算放宽导致召回不足 | 可调用 |
| 用户明确刷新实时价格 | 必须调用 |
| 缺少只能由用户决定的关键槽 | 0，先澄清 |

## 8. pi-agent 运行协议

### 8.1 每个 attempt 新建 Agent

不持久化 pi-agent 进程内消息。Worker 每次领取 Turn 后，从 PostgreSQL 生成受控 `ConversationContext`，创建新的 Agent 实例。这样崩溃恢复、重试和 fencing 不依赖进程内状态。

### 8.2 受控上下文

模型只接收：

- 当前用户消息；
- 当前 Goal 及版本；
- pending clarification/pending ops；
- 最近一个完整用户—助手邻接对；
- WorkingSet 的受控摘要、可绑定 refs 和当前 focus；
- 当前可用能力、时间、模型和 Provider 调用预算；
- 不确定/冲突/evidence gap。

不接收：完整 raw artifact、密钥、数据库内部 ID、无限 transcript、无关任务或其他租户数据。

### 8.3 工具与阶段机

```text
CONTEXT_READY
  └─ commit_turn_plan
         ▼
   PLAN_COMMITTED
         ▼
   EXECUTING_OP_1 ... EXECUTING_OP_N
         ▼
   ANSWER_REQUIRED
         ▼
   publish_reply
         ▼
   ANSWER_VALIDATED → COMMITTING → COMPLETED
```

#### `commit_turn_plan`

模型提交结构化 TurnPlan。宿主：

- 验证 GoalOps/WorldOps；
- 绑定引用；
- 拒绝越权事实；
- 计算是否真的需要 Research；
- 返回已接受计划、冲突和缺口。

#### 动态 WorldOps

`PLAN_COMMITTED` 后，宿主在 `commit_turn_plan` 的工具回调内，按 TurnPlan 顺序逐个执行已授权操作。每个 operation 仍映射到一个明确的 host capability/receipt：

- `patch_goal`；
- `undo_goal`；
- `reject_offers` / `restore_offers`；
- `set_comparison` / `set_focus`；
- `inspect_working_set` / `answer_from_evidence`；
- `refilter_working_set` / `rerank_working_set`；
- `research_offers`；
- `request_clarification`。

这些 capability 只修改 run-local `TurnDraft`，直到最终事务提交前都不是 Conversation 权威状态。`research_offers` 只有宿主 policy 判定允许时才执行；市场、预算、deadline、分页和调用次数由宿主注入，模型只提供有限 query variant 和研究理由。

模型不在提交计划后为每个 operation 再做一次 inference。否则普通单操作话轮至少需要“计划、执行、回答”三次 inference，与 8.4 的两次上限冲突。正式协议是：第一次 inference 通过 `commit_turn_plan` 声明式编排有序 operations；宿主在同一工具回调内执行并返回 receipts；第二次 inference 只能调用 `publish_reply`。这保留了 pi-agent 的计划/工具编排权，同时让确定性宿主持有执行与状态写权。

预算、撤销、选择比较集等结构化 UI 操作不需要模型重新猜测，而是直接编译成相同 WorldOp，进入同一个 durable Turn、执行器和事务提交协议。这是正式产品输入，不是兼容旁路。

#### `publish_reply`

提交 AssistantEnvelope：响应模式、已覆盖 op、claim blocks、clarification、next moves 和受限非事实连接语。宿主经过 ClaimVerifier 后持久化 AssistantMessage。

### 8.4 预算

- 常规 talk/refilter/compare/undo：最多 2 次模型 inference、0 次 Provider、输入不超过 8k tokens、输出不超过 1.5k tokens、wall time 不超过 8 秒；
- research：最多 4 次模型 inference；每个 market 首轮 1 次，Coverage 只允许额外 1 wave，因此 BuyWhere 总调用不超过 4；FX distinct currencies 不超过 3；目标 wall time 不超过 45 秒、硬 deadline 60 秒；
- 工具顺序执行；
- 超预算由宿主确定性收口，不允许无限重试；
- Provider 调用必须记录 market、timeout、result/error 和 artifact。
- Provider 只对 429、5xx、network、timeout 重试，尊重 `Retry-After`，最多重试 1 次并使用 full jitter；4xx、contract drift、validation 和 safety error 不重试；
- tenant/user RPM、并发、日成本，集群级 Provider bulkhead/token bucket 和 circuit breaker 必须在 `beforeToolCall` 前原子扣减预算。

## 9. 回答与证据边界

### 9.1 AssistantEnvelope

```ts
interface AssistantEnvelope {
  outcome: 'CHAT' | 'CLARIFICATION' | 'RECOMMENDATION' | 'NO_MATCH' | 'DEGRADED'
  addressedOpIds: string[]
  blocks: Array<
    | { type: 'TRANSITION'; text: string }
    | { type: 'CLAIM'; claimId: string }
    | { type: 'COMPARISON'; claimIds: string[] }
    | { type: 'QUESTION'; slotId: string; wording: string }
    | { type: 'DISCLOSURE'; disclosureCode: string }
  >
  nextMoves: TypedNextMove[]
}
```

### 9.2 ClaimVerifier

提交前必须证明：

- 价格、币种、汇率、市场、商户、库存、型号和成色都有允许的 EvidenceRef；
- 商品引用属于当前 WorkingSet/本轮新晋级集合；
- 不把 `UNKNOWN` 写成确定事实；
- 不把 Provider 市场归类写成配送资格；
- 不写运费、税费、保修、评分和真伪等缺失字段；
- ComparisonSet 内商品具有一致 comparison key；
- 用户明确排除的对象不会进入推荐；
- draftText 与结构化 claims 一致。

其中数字、币种、商户、市场、型号和库存只能由 claim block 渲染；`TRANSITION` 只能承载短小的非事实连接语。`addressedOpIds` 必须覆盖所有已执行操作。

失败时允许 Agent 在剩余预算内自纠一次；仍失败则由确定性 renderer 依据已验证 AssistantEnvelope skeleton 输出保守回复。

## 10. 数据模型

重建单一正式 schema，不为当前 `interec_v2` 保留双写。

### 对话与执行

- `conversations`
- `conversation_revisions`：parent/base revision、Goal/Dialogue/WorkingSet 指针
- `messages`：USER/ASSISTANT；全局 conversation sequence；结构化 payload；AssistantResponse 与 ASSISTANT message 严格 1:1
- `turns`：输入消息、base revision、状态、attempt、fence、lease、deadline、错误码
- `turn_events`
- `outbox`

### 目标与对话状态

- `goal_versions`
- `goal_operations`
- `dialogue_state_versions`
- `undo_entries`

### 候选世界

- `working_sets`
- `working_set_items`：POOL/DISPLAY/MENTIONED/COMPARISON/FOCUS role
- `provider_artifacts`
- `search_executions`
- `source_listings`
- `offer_qualifications`
- `comparison_sets`
- `comparison_set_items`
- `fx_snapshots`

### 输出与审计

- `assistant_responses`
- `assistant_envelopes`
- `decisions`：只有真正 recommendation/no-match 结果需要；普通消息不制造 Decision
- `claim_ledger`
- `tool_executions`：stable `step_key`、canonical request hash、attempt、状态和结果；调用前 durable
- `schema_migrations`：版本、checksum、应用时间

### 原子提交

一个 Turn 的最终事务同时完成：

1. 锁定 Conversation 和 Turn；
2. 验证 `RUNNING`、base revision、attempt、fence、lease 尚未过期；
3. 运行 ClaimVerifier；
4. 写 Goal/Dialogue/WorkingSet 新版本和 ConversationRevision；
5. 写 AssistantMessage/AssistantEnvelope/可选 Decision；
6. 原子更新 Conversation projection pointer 和 version；
7. 更新 Turn 终态；
8. 从 Conversation 行上的计数器分配 event seq，并追加 event/outbox。

任一步失败全部回滚。Provider artifact 和失败资格可以先作为 attempt-scoped 审计数据落库，但过期 attempt 不得晋级 Conversation 权威状态。

### 接收用户消息事务

1. 验证服务端认证后的 owner claims；
2. 校验 idempotency key 和 canonical payload hash；同 key 异 payload 返回 `409 IDEMPOTENCY_KEY_REUSED`；
3. 锁 Conversation，分配 message/event seq；
4. 写 USER message、Turn(base revision) 和 event/outbox；
5. 不在接收事务中修改 Goal、WorkingSet 或 DialogueState。

### 证据引用约束

- Money claim 必须绑定 source fact ID；CNY estimate 必须有 `fx_snapshot_id` 外键；
- EvidenceRef 的 artifact、json path、canonical value、provider/schema/policy version 必须进入 claim chain；
- final commit 验证 claim value 与不可变 artifact/FxSnapshot 一致；
- Provider artifact 按来源条款执行 TTL 清理，不能只保存 `expires_at` 字段而没有清理器。

## 11. 并发、取消与恢复

- 同一 Conversation 同时只有一个可提交 Turn。
- 用户在运行中发送纠正消息时，新 Turn supersede 旧 Turn，递增 fence；新 Turn 的输入是“自最后一个已提交 AssistantMessage 之后全部未消费 USER messages”的有序 batch，不能只取最后一句；旧 Provider 调用可被取消，已返回 artifact 只能审计，不能提交状态。
- 相同 `clientMessageId` 幂等返回同一 Turn。
- Worker lease 丢失或 deadline 到期后必须停止工具调用并拒绝提交。
- 外部调用允许 at-least-once；Conversation 状态发布必须 exactly-once。崩溃恢复从 immutable context snapshot、durable plan 和 step ledger 重放；已成功 step 按 request hash 复用。
- max attempts 为 3，耗尽后进入 `DEAD_LETTER`，产生 P1 告警并允许用户/人工显式 retry。
- SSE 使用单调 conversation event sequence 和 `Last-Event-ID` 恢复。
- 前端只根据 ConversationProjection/Turn status 判断进度；SSE 窗口结束只重连，不读取不存在的 Decision。
- Worker 重启从数据库恢复，不恢复 pi-agent 内存。

## 12. API 契约

```text
POST   /api/conversations
GET    /api/conversations/:id
GET    /api/conversations/:id/messages?after_seq=
POST   /api/conversations/:id/turns
GET    /api/conversations/:id/stream?after_seq=
POST   /api/turns/:id/cancel
POST   /api/conversations/:id/undo
POST   /api/conversations/:id/close
GET    /api/offers/:ref
```

`POST /api/conversations/:id/turns` 接受 `MESSAGE | PATCH_GOAL | UNDO | SET_COMPARISON`，使用 `clientTurnId` 幂等，并可携带 `expectedRevision`。这是一套正式 Turn 契约，不保留当前 `/v2` API。

`GET /api/conversations/:id` 返回一个原子 ConversationProjection：

- conversation；
- active turn；
- goal/conditions；
- pending clarification；
- working set display/comparison；
- 最新 AssistantMessage；
- event cursor。

删除当前“每次流结束后直接 GET Decision”的客户端协议。

身份不能再信任浏览器自报的 `x-tenant-id/x-actor-id`。生产 API 只接收由网关/JWT 验签后绑定的 server-side claims；PostgreSQL 使用 owner 条件并评估 RLS 作为 defense-in-depth。`/health/live` 只表示进程存活，`/health/ready` 必须验证数据库连接、schema checksum 和关键依赖配置。

## 13. 前端产品形态

### 桌面端

```text
┌──────────────────────────────┬─────────────────────────────┐
│ 对话线程                     │ 当前选购工作区              │
│ - 用户/助手消息              │ - Goal/条件                 │
│ - 澄清与快捷回答             │ - 主推荐/备选               │
│ - 条件变更与撤销             │ - 候选池/比较集             │
│ - 引用商品 chips             │ - 证据、FX、未知项          │
│ - 进度/失败/恢复             │ - 针对商品继续提问          │
│ composer                     │                             │
└──────────────────────────────┴─────────────────────────────┘
```

### 移动端

对话为主，候选工作区使用可切换抽屉/标签；不能把消息线程隐藏成一次性表单。

### 必须支持的交互

- 点击商品后“正在聊：X”；
- 推荐卡和回答引用互相定位；
- 条件 chip 只预填，不静默修改；
- 运行时允许取消；
- 刷新后恢复 thread 和 active turn；
- `CLARIFICATION` 展示为 AssistantMessage 和快捷选项；
- 失败留在原 Conversation，可直接重试或改条件。

## 14. 可观测性与隐私

### Trace 层级

```text
conversation_id（session）
  └─ turn_id（root Agent trace）
       ├─ pi-agent inference
       ├─ tool
       ├─ provider
       ├─ qualification/ranking
       └─ commit
```

### 指标

- turn terminal status；
- route/operation 分布；
- clarification rate 和 resolution rate；
- provider calls per turn；
- unnecessary research rate；
- referent binding failures；
- evidence blocks/claim rejections；
- supersede/cancel/fence failures；
- token/cost/latency；
- SSE reconnect 和 projection lag。

默认继续关闭内容采集。Langfuse metadata 只允许受控 ID、模型、工具、状态、token/cost、reason code 和数量；禁止 raw query、prompt、商品 artifact、命令行、密钥和跨租户信息。

用户 pseudonymous ID 使用可轮换 HMAC，而不是对可能可枚举 actor 标识做无密钥 SHA256。生产内容采集默认强制关闭；任何例外都必须有 tenant consent、DLP 和保留期限。消息、查询、Provider artifact 必须定义加密、TTL、删除和审计政策。

Outbox 必须二选一：实现 `SKIP LOCKED` publisher、retry、dead letter、幂等 consumer 和积压指标；或者删除 outbox，使用明确的数据库事件读取模型。禁止保留“只写不发”的名义 outbox。

## 15. 保留、重写与删除

### 保留并增强

- `packages/domain` 中 Money、Evidence、ProductIdentity、qualification、ComparisonSet；
- PostgreSQL lease/heartbeat/fence/deadline/outbox 思路；
- BuyWhere/FX adapter 与错误归一化；
- artifact、tool receipt、Langfuse/OTel 隐私边界；
- TypeScript workspace、CI 和 architecture check。

### 重写

- `pi-executor.ts`：从 Research-only executor 改为 Turn orchestrator；
- `pi-tools.ts`：替换三工具阶段机；
- `shopping-run-handler.ts`：改为 ConversationTurnHandler；
- RunStore/Repository：升级为 Conversation + Turn 原子投影；
- API：以 ConversationProjection/Message/SSE 为主；
- `frontend/src/App.tsx` 和 `frontend/src/v2/client.ts`：恢复真正对话工作台。

### 删除

- `ResearchAction = CLARIFICATION | INSPECT | DISCOVER` 作为完整话轮模型；
- “所有成功话轮必须产生 Decision”的约束；
- clarification/no-match 等同 Conversation 结束的语义；
- 当前单 textarea + 最终 Decision 页面；
- 当前 `/v2` 单轮客户端契约；
- 旧 Python runtime 和旧前端的兼容入口；
- fixture/live 双实现、双写、旧 DTO adapter 和仅为历史测试存在的分支；
- 与最终架构冲突的实施验收文档。

## 16. 实施工作包

### WP0：产品契约与删除边界

- 固化本文、对话轨迹和事实边界；
- 将当前单轮实现标记为 rejected baseline；
- 列出保留内核与直接删除对象；
- architecture check 改为只允许最终目标架构。

**DoD**：所有团队角色对 Conversation/Turn、模型/确定性边界和无兼容策略签字。

### WP1：领域与状态模型

- 实现 GoalOperations、TurnPlan、WorldOp、WorkingSet、DialogueState、AssistantEnvelope；
- 实现 referent binder、undo、ConversationPolicy、ClaimVerifier；
- 扩充属性/证据 contract，但不虚构 BuyWhere 能力。

**DoD**：性质测试覆盖操作顺序、幂等、undo、绑定、集合单调性和集合外引用拒绝。

### WP2：全新 schema 与 repository

- 创建 Conversation/Message/Turn/State/WorkingSet/Response 表；
- 实现原子接受消息、claim、heartbeat、supersede 和 final commit；
- event seq 使用 Conversation 行原子计数器，不使用 `MAX(seq)+1`；
- migration 使用不可变编号文件、checksum table、advisory lock、事务和 schema verifier，禁止 `IF NOT EXISTS` 掩盖 drift；
- 开发环境直接重建，不迁移现有试验数据；需要保留的验收 artifact 单独导出归档。

**DoD**：双 worker、崩溃恢复、失败/取消/supersede draft 不可见、expired lease commit 拒绝、同 idempotency key 异 payload 返回 409、并发 event seq、外调回执前后崩溃、final commit 回滚、连续未消费 user message batch、旧 attempt artifact 不晋级和 SSE cursor 集成测试全绿。

### WP3：pi-agent Turn Orchestrator

- 新建 `packages/agent`；
- 实现上下文投影、五工具协议、动态 tool exposure、预算和自纠；
- 将模型 proposal 与宿主执行严格分离；
- 普通问答与复用路径不调用 Provider。

**DoD**：tool contract tests + trajectory faux model tests 覆盖每个 phase、非法工具、漏提交和预算耗尽。

### WP4：Research 与 proof pipeline 集成

- 将现有 proof-carrying pipeline 接入 WorkingSet；
- 实现 ResearchWave 合并、Coverage 和停止条件；
- ComparisonSet 变成 Conversation-scoped version；
- Provider 失败保留证据，不覆盖顶层原因。
- 为 source fact、artifact 和 FX snapshot 建立可校验 FK/claim chain；实现 artifact TTL cleaner；
- 增加 cluster bulkhead、tenant quota、retry budget、circuit breaker 和 durable step receipt。

**DoD**：新增未验证低价不改变主推荐；市场冲突、配件、型号/成色不一致全部 fail closed。

### WP5：API 与 SSE

- 实现 ConversationProjection 和 message timeline；
- 事件以 conversation sequence 恢复；
- 取消、undo、重试和 focus 契约；
- 错误码映射为可继续的对话状态。
- 替换客户端自报身份为验签后的 server-bound claims，并增加租户隔离/RLS 测试；
- 实现 readiness、outbox publisher 或明确删除 outbox。

**DoD**：刷新、断线重连、重复 event、终态和无 Decision 普通消息均正确。

### WP6：对话工作台

- 重建 thread、composer、condition chips、progress、candidate workspace、drawer、compare；
- 实现桌面和移动布局；
- 所有 AssistantMessage 引用可定位到候选；
- 页面刷新恢复。

**DoD**：桌面/移动视觉验收和键盘/屏幕阅读器基本可用性通过。

### WP7：轨迹评测与真实验收

- 离线 trajectory corpus；
- PostgreSQL vertical slices；
- 浏览器端到端；
- 单 run 精确 live；
- 真实多轮 gold、Shadow、SLO 和人工审计。

**DoD**：第 17 节门槛全部满足后才允许发布。

### WP8：单实现收口

- 删除当前单轮协议、过时文档和无引用代码；
- 删除旧 schema/命令/环境变量；
- README、Makefile、CI、runbook 只描述最终实现；
- dependency graph 和 dead-code gate 通过。

**DoD**：仓库、运行入口、CI、文档和部署只剩一套正式实现。

## 17. 必须通过的验收矩阵

### 多轮产品轨迹

1. “想买降噪耳机” → 只问一个能改变检索空间的澄清问题。
2. 用户补充“2500 元，比较美国和新加坡” → 延续同一 Conversation 并检索。
3. “第二个为什么更贵？” → 正确绑定第二件，零 Provider 调用。
4. “太贵了，不要粉色，第三个呢？” → 同轮完成态度、排除和询问，不重新检索。
5. “只看美国” → 基于已有 pool refilter；若证据足够，零 Provider 调用。
6. “换成 XM4” → 更新型号并新检索，旧 XM5 不混入新 ComparisonSet。
7. “撤销刚才的型号修改” → Goal/WorkingSet 回到上一个有效版本。
8. 商品详情点击“问问这个”后输入“有货吗？” → focus ref 准确绑定。
9. 刷新页面 → thread、条件、候选、焦点和 active turn 恢复。
10. 运行中发送纠正 → 旧 turn 被 fence，不能覆盖新状态。
11. “预算加到 3000，只看新加坡，而且不要第二个” → 同轮操作完整提交，不能只执行一个 intent。
12. “为什么选它？保修有吗？” → 解释有证据取舍，保修明确未知，零额外 Provider 调用。

### 事实与安全

- 所有金额与市场 claim 有 EvidenceRef；
- UNKNOWN 不写成已知；
- 配件、型号、成色和市场冲突 fail closed；
- 集合外引用为 0；
- raw query/content 默认不进入 Langfuse；
- 跨租户读取、事件和工具回执为 0。

### 可靠性

- unit/property/contract/trajectory tests 全绿；
- PostgreSQL 并发与恢复测试全绿；
- API/SSE/browser E2E 全绿；
- 至少 100 条人工标注的真实模型多轮 gold，其中至少 50 条为 3+ 轮：关键轨迹 100%、schema validity 100%、hard constraint state 100%、grounded claim validity 100%、集合外引用 0、配件/错型号晋级 0、零检索路径外调 0、route/multi-op recall ≥95%、referent ≥98%、澄清后两轮内恢复 ≥90%；
- Shadow 至少 1000 个有效 turns、200 个 3+ 轮 conversations、每个关键 route 达到最低样本配额、版本一致，并对 100 条执行人工双审；时间长度不能替代样本和质量证据；
- Dashboard、告警、on-call runbook 和回滚演练完成。

当前 `140 passed` 只能证明 domain/协议单元基线：其中 100 条是模板生成的 evidence scenarios，不是多轮 trajectory 或真实模型 gold，不能进入上述完成统计。

### 初始 SLO（Shadow 后用数据批准或调整）

- enqueue P95 < 300ms；
- projection P95 < 500ms；
- SSE lag P95 < 1s；
- talk/refilter P95 < 8s；
- research P95 < 45s、P99 < 60s；
- queue wait P95 < 2s；
- lease 接管 < 20s；
- system failure < 1%；timeout < 1%。

跨租户、secret leak、无证据事实、硬约束违规、错品类推荐或状态回退任一出现，立即阻断发布。

任何单次 live 成功都不能替代上述多轮与样本门槛。

## 18. 发布和切换策略

本项目当前处于开发重构阶段，不建设 compatibility migration：

1. 在同一工作分支直接形成最终 TypeScript 实现；
2. 测试环境重建 schema；历史真实验收记录以脱敏文档/fixture 保存，不迁移为线上状态；
3. 离线和 PostgreSQL 门禁通过后，使用精确 conversation/turn 的受控 live；
4. Shadow 只对最终实现采样，不双写旧实现；
5. 切换前 drain worker、阻断新写、创建备份/PITR checkpoint、运行一次性转换与校验，并原子切换入口；
6. 发布采用部署版本和数据库快照/PITR 回滚，不采用运行时旧/新引擎开关；建议 RTO ≤30 分钟、RPO ≤5 分钟，最终由产品/运维签字；
7. kill switch 只能暂停外调或缩小品类，不能切回旧引擎；
8. 切换后删除 rejected baseline、旧 schema 和过时配置；破坏性 contract migration 在稳定观察期后执行。

## 19. 架构否决项

以下方案直接拒绝：

- 在当前一次性页面上增加聊天气泡并继续每轮重搜；
- 把完整 transcript 直接交给模型当记忆；
- 让模型直接产生未经验证的推荐文本；
- 用更多 prompt 和 inference 次数替代宿主状态机；
- 为旧 Python/旧 V2 保留 adapter、双写、feature flag 或长期 schema；
- 用单轮 Sony live 成功宣称对话产品通过；
- 因测试方便而保留与产品语义冲突的 `Decision-per-turn`；
- 先删原行为、以后再补 parity，而验收仍称“完成”。

## 20. 审批原则

方案只有在以下各方都满足条件时才能进入实施完成态：

- 产品：十二条多轮轨迹全部可用，Conversation 不被单 Turn 终态截断；
- Agent 架构：pi-agent 真正承担话轮计划与受限工具编排，且不能越过事实边界；
- 领域/证据：所有推荐与事实可证明、可重放、可拒绝；
- 可靠性：并发、恢复、deadline、fence、SSE 和原子提交有数据库证据；
- 安全/隐私：默认最小采集、租户隔离和外部调用预算可审计；
- 前端：对话、状态和候选工作区形成完整任务体验；
- 发布：gold、Shadow、SLO、告警和回滚门槛真实通过。

任意一方 REJECT，不能用“已有测试全绿”覆盖其否决理由。
