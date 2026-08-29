# InteRecAgent 项目架构定位与面试说明

本文面向高水平校招技术面试，目标不是罗列技术栈，而是说明：项目解决了什么问题、为什么这样分层、LLM 的权限边界在哪里，以及系统如何保证状态一致性与商品事实可信。

本文以当前 TypeScript Conversation Runtime 为准。内部资格测试、开发期抽样和故障注入结果只用于工程决策，不应包装成真实业务增长指标。

## 30 秒项目介绍

InteRecAgent 是一个面向跨境购物的有状态对话式推荐系统。它不是让大模型直接搜索商品并自由回答，而是采用“LLM 语义提案、确定性系统执行”的架构：pi-agent 负责理解用户语言、提出结构化 `TurnPlan` 和组织回复；Intent Compiler、Conversation Policy 与确定性 Turn Execution Host 负责意图冲突消解、状态变更、外部调用授权、商品证据校验和回复发布。系统使用 PostgreSQL 持久化 Conversation、Turn、WorkingSet、Claim 和 Evidence，通过独立 Worker、lease、fencing 与事务实现可恢复、可审计的话轮执行。

## 一句话架构定位

> 以 PostgreSQL 为权威状态源、以 Durable Turn 为执行边界、以 pi-agent 为受约束语义规划器、以确定性 Host 为业务裁决者的证据驱动型对话推荐系统。

更完整的工程标签是：

- TypeScript 模块化单体；
- API/Worker 双进程运行拓扑；
- PostgreSQL-backed durable execution；
- DDD-influenced + Ports and Adapters；
- Schema/Policy 驱动的单 Agent；
- Proof-carrying recommendation；
- 版本化状态 + Transactional Outbox + SSE Projection；
- Evaluation-first AI engineering。

它不是多 Agent 系统、纯 RAG 应用、自由工具 Agent、微服务架构或纯 Event Sourcing 系统。

## 主体架构

```text
React Conversation UI
        │ REST + Bearer JWT
        │ SSE cursor events
        ▼
Fastify Conversation API
        │ accept Message / Turn
        ▼
PostgreSQL authoritative state
        │ claim + lease + fence
        ▼
Durable Turn Worker
        │ bounded ConversationSnapshot
        ▼
fresh pi-agent ───────────────► DeepSeek / OpenAI
        │ TurnPlanProposal
        ▼
model-facing schema / source grounding
        ▼
Intent Compiler
        ▼
Conversation Policy
        ▼
Deterministic Turn Execution Host
        │
        ├── Goal / Dialogue / WorkingSet reducers
        ├── referent binding / undo / local reranking
        ├── Claim / Evidence / disclosure verification
        └── TurnWorldPort
                 ├── local observed-candidate cache
                 ├── governed BuyWhere product search
                 └── governed FXRates lookup
        │
        ▼
Operation Receipts
        │
        ▼
pi-agent publish_reply proposal
        │
        ▼
Host validation + atomic revision publication
        │
        ▼
PostgreSQL Message / State / Event / Outbox
        │
        └── SSE ──► UI projection refresh
```

## 分层与依赖方向

| 模块 | 架构职责 | 关键内容 |
| --- | --- | --- |
| `packages/domain` | 确定性领域内核 | Goal、WorkingSet、TurnPlan、商品资格、排序、Claim 验证 |
| `packages/agent` | AI 与业务之间的适配层 | 上下文投影、pi-agent 协议、TypeBox Schema、Intent Compiler、Host |
| `packages/runtime` | 应用运行时和基础设施 | Worker、PostgreSQL Repository、Research World、Provider 治理、Telemetry |
| `packages/api` | 接入层 | JWT、REST、ConversationProjection、SSE |
| `frontend` | 用户交互层 | 对话输入、候选展示、比较、进度、失败重试 |
| `spec` / `scripts` | 质量控制面 | 产品契约、Gold、协议对抗、故障验收、漂移检查 |
| `ops` | 运维面 | OpenTelemetry、Langfuse、Prometheus、Grafana |

主要依赖方向为：

```text
domain ← agent ← runtime ← api

frontend ── HTTP/SSE ──► api
```

领域层不依赖 Fastify、PostgreSQL 或具体模型 Provider；Host 通过 `TurnWorldPort` 与外部商品世界交互，Runtime 再提供 PostgreSQL、BuyWhere 和 FX 的具体适配器。

## 核心概念

### Conversation 与 Turn

`Conversation` 是长期购物任务，保存跨轮 Goal、候选世界、对话状态和消息历史。

`Turn` 是一次可持久化执行边界，具有：

- 输入消息批次；
- `baseRevision`；
- deadline；
- lease 与 heartbeat；
- attempt 与 fence token；
- draft、成功、失败、取消、超时和 supersede 状态。

Turn 完成只表示原子发布了一条 AssistantMessage 和一版新状态，不代表 Conversation 结束。

### WorkingSet

`WorkingSet` 是跨轮持久的候选集合，也是自然语言指代的稳定边界。它保存：

- 候选池；
- 当前展示顺序；
- 已提及、拒绝、聚焦和比较的候选；
- 与 Goal version 的绑定关系；
- 候选关联的 Claim 与证据级别。

“第二个”“这款”“刚才比较的两个”不能由模型根据自由文本猜测，而是由 Host 在当前 WorkingSet 上绑定。

### Claim 与 Evidence

模型不能直接发布“有货”“更便宜”“来自美国市场”等事实。商品事实必须经过：

```text
Provider Artifact
  → Source Listing
  → Product Identity
  → Qualification
  → Source Fact
  → EvidenceRef
  → Verified Claim
  → AssistantEnvelope
```

这是一种正向证据准入：不是发现已知坏结果后排除，而是只有具备足够证据的事实才允许晋级和发布。

## Worker、pi-agent、Intent Compiler 与 Host 的边界

### Worker：执行生命周期控制器

Worker 是独立运行的 TypeScript 后台进程，负责：

- 从 PostgreSQL 领取 Turn；
- 建立 lease、heartbeat 和 fencing；
- 加载指定 revision 的 ConversationSnapshot；
- 创建本轮 Research World、Host 和 fresh pi-agent；
- 管理 deadline、取消、重试和失败；
- 记录运行指标；
- 确认本轮是否完成最终提交。

Worker 关心“任务何时、由谁、以哪个 attempt 执行”，不负责解释自然语言，也不直接定义商品事实。

### pi-agent：受约束语义规划器

项目没有修改或 fork `@earendil-works/pi-agent-core`。它作为通用 Agent Loop，提供：

- 模型调用循环；
- function tool 调用；
- 流式事件；
- 取消与终止；
- 工具调用结果回传。

项目通过公开扩展点注入：

- 自定义 System Prompt；
- DeepSeek/OpenAI 模型与 `streamFn`；
- TypeBox 工具 Schema；
- 阶段化工具列表；
- `beforeToolCall` 权限和调用预算；
- 顺序工具执行；
- 协议修复与 Host fallback；
- Telemetry 事件订阅。

pi-agent 负责“理解、提案、表达”，不拥有数据库、商品世界或最终发布权。

### Intent Compiler：语义效果编译器

模型先提出结构化语义效果，Intent Compiler 再将它编译为可执行计划。它负责：

- 按消息来源和操作顺序消解同一 Goal 字段的冲突；
- 保留最新的有效修改；
- 从已经明确的持久语义派生机械后果；
- 保证“状态变化”与“展示变化”一致。

例如用户要求价格优先时，模型只能提出持久语义：

```text
GOAL_UPSERT_PREFERENCE(price)
```

Intent Compiler 可以进一步派生 Host-only 操作：

```text
RERANK_WORKING_SET(price)
```

Compiler 不重新解析用户自然语言，也不为模型补造缺失意图。

### Host：确定性业务执行与裁决边界

代码中的 `ConversationTurnDraftHost` 更准确的专业表述是：

> Policy-Enforced Turn Execution Host，受策略约束的确定性话轮执行器。

它负责：

- 校验和规范化模型提案；
- 将 Goal 操作绑定到原始用户消息；
- 稳定候选指代；
- 应用 Conversation Policy；
- 执行 Goal、WorkingSet 和 World 操作；
- 控制 Provider 调用授权；
- 生成 Operation Receipt；
- 验证 Claim、Evidence、Question 和 Disclosure 白名单；
- 触发 attempt draft 保存和最终原子提交。

Host 不是物理服务器，也不是独立进程，而是 Worker 为每个 Turn 创建的确定性应用执行对象。

## pi-agent 的两阶段工具协议

模型真正看到的工具只有两个：

```text
CONTEXT_READY  ──► commit_turn_plan
ANSWER_REQUIRED ─► publish_reply
```

### commit_turn_plan

模型提交：

```json
{
  "userIntentSummary": "寻找美国市场的降噪耳机",
  "ops": [
    { "opId": "target", "kind": "GOAL_SET_TARGET", "sourceMessageOrdinal": 0 },
    { "opId": "market", "kind": "GOAL_SET_RETRIEVAL_MARKETS", "sourceMessageOrdinal": 0 },
    { "opId": "research", "kind": "RESEARCH_OFFERS", "reasonCode": "GOAL_BECAME_RESEARCH_READY" }
  ]
}
```

Host 校验后按顺序执行操作，并返回：

- `claimIds`；
- `questionSlotIds`；
- `disclosureCodes`；
- 结构化 `publicResult`；
- 每个操作的状态。

### publish_reply

模型只能根据 receipts 中允许的 ID 组织 AssistantEnvelope，不能直接抄写或创造商品事实。Host 会补充必要披露、生成确定性问题措辞并重新验证完整回复。

正常路径通常是两次模型工具调用；额外预算用于协议修复，而不是让模型自由循环调用外部系统。

## 模型为什么知道有哪些领域操作

`RESEARCH_OFFERS`、`INSPECT_WORKING_SET` 和 `INSPECT_RESEARCH_COVERAGE` 不是三个独立 pi-agent Tool，而是 `commit_turn_plan.ops[]` 中允许出现的领域操作。

模型从三个渠道获得信息：

### 1. Tool Schema：告诉模型“可以提出什么”

`commit_turn_plan.parameters` 指向 TypeBox 定义的 `turnPlanSchema`。`turnOperationSchema` 使用联合类型和 `Type.Literal` 枚举所有模型可见操作及参数。

Provider 最终收到的结构近似：

```json
{
  "name": "commit_turn_plan",
  "parameters": {
    "properties": {
      "ops": {
        "items": {
          "anyOf": [
            { "kind": { "const": "INSPECT_WORKING_SET" } },
            { "kind": { "const": "INSPECT_RESEARCH_COVERAGE" } },
            { "kind": { "const": "RESEARCH_OFFERS" } }
          ]
        }
      }
    }
  }
}
```

### 2. System Prompt：告诉模型“什么时候提出”

项目明确规定：

```text
询问候选价格、库存、型号等
→ INSPECT_WORKING_SET

询问市场是否搜索过、哪些市场失败、空结果是否证明当地无售
→ INSPECT_RESEARCH_COVERAGE

明确要求刷新或重新搜索
→ RESEARCH_OFFERS
```

### 3. Conversation Context：告诉模型“当前有什么”

模型收到经过裁剪的结构化上下文，包括：

- 当前用户消息及 ordinal；
- Goal；
- pending clarification；
- WorkingSet 候选与展示顺序；
- UI focus；
- 最近相邻对话；
- runtime capabilities；
- Provider call budget。

因此：Schema 决定模型的语法能力，Prompt 提供语义路由规则，Context 提供本轮决策条件。

“模型知道可用”不代表“模型有权执行”。完整控制链是：

```text
Schema：是否允许提出
Prompt：什么语义下应该提出
Intent Compiler：怎样消解与派生
Policy：当前状态是否允许
Host：怎样执行与验证
Repository：是否允许最终提交
```

## 外部系统的信任边界

| 参与者 | 可以做什么 | 不能做什么 |
| --- | --- | --- |
| LLM | 理解语言、提出计划、组织回复 | 直接写状态、授权 Provider、创造商品事实 |
| pi-agent | 运行模型/工具循环 | 决定领域规则和数据库提交 |
| Intent Compiler | 编译已提出的语义效果 | 从原始文本发明新意图 |
| Host | 校验、执行、生成 receipts、验证发布 | 绕过 Repository 强制提交 |
| BuyWhere | 提供发现型商品观察 | 自动证明销售地、配送资格和最终可购买性 |
| FXRates | 提供带时间边界的汇率观察 | 决定最终结算金额 |
| PostgreSQL | 保存权威状态、证据和执行边界 | 理解自然语言 |

这里有两个不信任边界：

1. 模型输出是不可信提案，必须经过 Schema、grounding、Compiler、Policy 和 Host；
2. Provider 输出是不可信观察，必须经过 artifact 持久化、身份识别、资格校验和 Evidence/Claim 晋级。

## 一次自然语言 Turn 的完整链路

以“预算 3000 元，在美国找一款降噪耳机”为例：

1. React 调用 Fastify API 提交 Message；
2. API 验证 JWT，将 Message 与 Turn 写入 PostgreSQL，返回 `202 Accepted`；
3. Worker 使用 `FOR UPDATE SKIP LOCKED` 领取 Turn；
4. Worker 建立 lease、heartbeat、attempt 和 fence token；
5. Worker加载指定 `baseRevision` 的 ConversationSnapshot；
6. Worker 创建 Research World、Repository Turn Session 和 Host；
7. Worker 将有界上下文交给 fresh pi-agent；
8. 模型通过 `commit_turn_plan` 提出目标、预算、市场、约束和研究操作；
9. Host 执行 grounding、Intent Compiler、指代稳定和 Conversation Policy；
10. Policy 授权最多一次逻辑研究；
11. Research World 优先检查本地候选缓存，否则通过 Provider Governor 调用 BuyWhere 与 FX；
12. Runtime 保存 artifact、source fact、qualification、evidence 和 WorkingSet；
13. Host 返回只包含安全 Claim ID 的 receipts；
14. 模型通过 `publish_reply` 组织回复；
15. Host 验证 Claim/Evidence 和必要披露；
16. Repository 在一个事务中提交 Goal、Dialogue、WorkingSet、AssistantMessage、Claim 和 Event；
17. API 通过带 cursor 的 SSE 发送事件；
18. 前端重新加载 ConversationProjection。

结构化 UI 输入如 `PATCH_GOAL`、`UNDO` 和 `SET_COMPARISON` 可以绕过 LLM，直接构造确定性计划交给 Host 执行。这说明 LLM 是自然语言入口，不是所有业务操作的必经核心。

## 为什么使用 PostgreSQL Durable Worker，而不是 Redis 队列

当前 Turn 与 Conversation 状态、消息、revision、attempt、Claim、Evidence 和事件高度耦合。使用 PostgreSQL 可以在同一个事务边界内处理：

```text
接受消息
创建 Turn
记录事件
提交状态
```

如果增加 Redis/BullMQ，Redis 不能替代 PostgreSQL，只会引入 PostgreSQL 与 Redis 双写：

```text
PostgreSQL 成功、Redis 入队失败
Redis 入队成功、PostgreSQL 回滚
```

当前选择的收益是：

- 单一权威状态源；
- 任务与业务状态事务一致；
- 审计和恢复路径直接；
- 复用 PostgreSQL RLS；
- 减少基础设施和运维复杂度。

代价是：

- 队列吞吐和领取延迟不如 Redis；
- 轮询、行锁和表膨胀会形成规模上限；
- 大量短任务时会占用数据库连接。

如果未来队列吞吐成为瓶颈，可以保留 PostgreSQL 作为权威状态源，通过 Transactional Outbox 将任务投递到 Redis/BullMQ；Worker执行前后仍需回到 PostgreSQL 校验 fence 和提交状态。

## 一致性语义

面试中不要笼统宣称“整个系统 exactly once”。更准确的说法是：

- 外部模型和 Provider 调用允许 at-least-once；
- durable ledger 和 stable request identity 用于重放及去重；
- attempt draft 只属于当前 attempt；
- 正式 Conversation revision 受 `baseRevision + attempt + fence + lease` 约束；
- AssistantMessage、状态、Claim 和事件在最终 PostgreSQL 事务中原子发布；
- 过期、取消、失败或被 supersede 的 attempt 不能晋升为 latest revision。

因此项目保证的是“受 fencing 保护的原子状态发布”，而不是宣称所有网络副作用都只发生一次。

## 推荐系统的双通道设计

项目没有为每个商品品类复制一个 Agent，而是采用：

- `VERIFIED`：对注册 CategoryContract 执行型号、主商品/配件、成色和市场资格校验；
- `DISCOVERY`：对开放品类提供搜索、排序和反馈能力，但身份不足时保持 `OFFER_ONLY`。

这种设计将“语言理解能力”与“品类事实验证能力”分离。扩展新品类时优先增加数据契约、商品目录和证据源，而不是复制 Prompt 或创建新的品类 Agent。

## 质量与评估体系

项目将 AI 评估视为独立架构面，而不只依靠单元测试：

- 产品不变量和多轮轨迹契约；
- Domain、Host 与协议单元测试；
- PostgreSQL/API 集成测试；
- Gold blueprint 与任务评估；
- 协议对抗测试；
- 故障注入和运行验收；
- Provider replay fixture；
- 模型与服务契约漂移检查；
- Langfuse/OpenTelemetry 可观测性。

评估需要区分：

1. 协议是否完成；
2. 事实是否安全；
3. 最终业务语义是否完整；
4. Provider 是否属于有效样本。

协议成功不等于业务回答完整，安全 fallback 也不应被包装成成功推荐。

## 架构优点

### 1. LLM 可替换

模型只输出稳定协议，业务规则不写在模型内部。DeepSeek 与 OpenAI 可以通过同一 `pi-ai` 接口切换。

### 2. 事实边界清晰

模型不能越过 Evidence/Claim 链直接陈述商品事实，Provider 新增字段也不会自动获得发布权限。

### 3. 多轮状态可恢复

Goal、WorkingSet、消息、attempt 和 evidence 都持久化，Worker 重启不会丢失对话状态。

### 4. 零 Provider 路径

比较、解释、过滤、拒绝、恢复、重排和撤销在已有证据充分时可以不调用外部服务，降低延迟和成本。

### 5. 一致性和审计优先

系统能够回答某个事实来自哪个 Provider artifact、哪次 research wave、哪个 source fact 和哪次 revision。

## 当前限制与演进方向

### Host 复杂度

`ConversationTurnDraftHost` 当前同时承担 grounding、指代处理、计划规范化、状态执行、恢复与发布验证，代码规模正在接近大型应用服务。后续可以在保持统一权限边界的前提下拆为：

```text
ProposalGrounder
IntentCompiler
ReferentBinder
ConversationPolicy
TurnOperationExecutor
ReplyPublicationVerifier
```

### SSE 数据库轮询

当前 SSE 通过定期读取 PostgreSQL event cursor 实现，适合当前规模。连接数扩大后可以引入 LISTEN/NOTIFY、专用事件中继或流系统。

### PostgreSQL 队列规模上限

当前设计优先一致性和低基础设施复杂度。如果任务吞吐显著增加，可由 Transactional Outbox 向专用队列分发，但不能把 Redis 队列状态升级为业务权威状态。

### 模型协议波动

模型可能遗漏操作或生成非法工具参数。当前策略是协议修复后安全 fallback；后续应通过重复运行、错误分类和 Schema 简化解决通用问题，而不是按具体问句增加规则。

### 商品数据能力

当前推荐质量上限主要由目录、型号映射、规格、评论和可验证事实源决定。引入向量检索或训练 Ranker 应建立在足够数据与流量证据之上。

## 高频追问参考答案

### 为什么不让模型直接调用 BuyWhere？

因为模型应该决定“是否需要研究”的语义提案，但不能拥有 Provider 授权、租户配额、请求幂等和事实晋级权。Host 与 Provider Governor 可以统一实现预算、并发、熔断、证据持久化和审计。

### pi-agent 被修改了吗？

没有。项目使用标准依赖，通过公开的模型、工具、Hook、事件和停止条件接口适配。新增的是项目自己的 Prompt、TypeBox Schema、两阶段工具协议、Intent Compiler 和 Host。

### 模型为什么知道 `RESEARCH_OFFERS`？

因为它出现在 `commit_turn_plan` 的参数 Schema 中，System Prompt 说明适用语义，Conversation Context 提供当前状态。模型只获得提案能力，Host 才拥有执行授权。

### Host 这个名称专业吗？

`Host` 在 Agent/MCP 架构中是成立的术语，但单独使用较宽泛。面试中建议首次表述为“Deterministic Turn Execution Host，确定性话轮执行器”，后续简称 Host。

### 为什么每个 Turn 创建 fresh pi-agent？

持久状态已经由 PostgreSQL ConversationSnapshot 管理。每次创建 fresh agent 可以避免把进程内模型历史误当作权威状态，保证 attempt 重试从同一个 `baseRevision` 开始，并降低跨租户或跨 attempt 的隐式状态泄漏。

### 如何防止模型幻觉？

不是试图消除模型生成错误，而是限制错误的影响范围：Schema 限制语法，source grounding 限制来源，Intent Compiler 限制派生，Policy 限制外调，Host 限制状态变化，ClaimVerifier 限制事实发布，Repository 限制最终提交。

### 这是微服务吗？

不是。它是一个 npm workspaces 模块化单体，在运行时拆成 API 和 Worker 两个进程，共享领域包、Runtime 和 PostgreSQL。这个拆分是执行拓扑隔离，不是独立服务自治。

### 这是 Event Sourcing 吗？

不是纯 Event Sourcing。项目直接持久化版本化 ConversationState、消息和领域记录，同时写入事件与 Outbox，用于通知、审计和 Projection cursor。

## 面试表达红线

不要说：

- “大模型负责做推荐和调用所有外部工具”；
- “系统实现了全链路 exactly once”；
- “这是微服务、多 Agent 或 Event Sourcing”；
- “BuyWhere 返回的就是已验证商品事实”；
- “用了内部评估结果，所以线上推荐效果提升了某个百分比”；
- “用了 Langfuse 就解决了模型评估问题”；
- “使用 PostgreSQL 是因为 Redis 不可靠”。

建议说：

- “LLM 负责开放语义，确定性系统负责业务裁决”；
- “外部调用允许重试，正式状态采用 fencing 保护的事务发布”；
- “BuyWhere 是 Discovery Source，事实必须经过 Evidence/Claim 晋级”；
- “当前选择 PostgreSQL 是一致性、审计和基础设施复杂度之间的阶段性权衡”；
- “评估区分协议、事实安全和业务完成度”。

## 代码导览

| 主题 | 入口 |
| --- | --- |
| pi-agent 适配与 System Prompt | `packages/agent/src/turn-agent.ts` |
| 两阶段工具协议 | `packages/agent/src/protocol.ts` |
| 模型侧 TypeBox Schema | `packages/agent/src/schemas.ts` |
| Conversation Context 投影 | `packages/agent/src/context.ts` |
| Intent Compiler | `packages/agent/src/intent-compiler.ts` |
| 确定性 Host | `packages/agent/src/draft-host.ts` |
| Conversation Policy | `packages/domain/src/conversation-policy.ts` |
| Turn Worker | `packages/runtime/src/conversation-worker.ts` |
| Repository Turn Session | `packages/runtime/src/repository-turn-session.ts` |
| 外部研究世界 | `packages/runtime/src/conversation-research-world.ts` |
| PostgreSQL Repository | `packages/runtime/src/postgres-conversation-repository.ts` |
| 商品证据管线 | `packages/runtime/src/research-proof.ts` |
| Fastify API/SSE | `packages/api/src/app.ts` |
| 前端 Projection 消费 | `frontend/src/App.tsx` |

## 两分钟面试讲述版本

> 我做的是一个跨境购物场景的多轮对话推荐系统。它最核心的设计不是接入了哪个模型，而是把概率性的语言理解和确定性的业务执行分开。
>
> 系统把 Conversation 作为长期购物任务，把 Turn 作为可租约、重试、取消和审计的持久执行边界。用户消息先由 Fastify API 写入 PostgreSQL，Worker 再通过 lease 和 fence 领取 Turn。每个 attempt 都从指定 revision 的快照创建 fresh pi-agent。
>
> pi-agent 没有被修改，只作为通用模型与工具循环。模型只看到 `commit_turn_plan` 和 `publish_reply` 两个工具。它通过 TypeBox Schema 知道可以提出哪些领域操作，通过 System Prompt 知道何时使用，通过结构化 Conversation Context 知道当前 Goal 和 WorkingSet。模型提交的计划还要经过原文依据校验、Intent Compiler 和 Conversation Policy，最后由确定性 Host 执行。
>
> 外部 BuyWhere 和汇率服务不直接暴露给模型，而是位于 Host 后面的 WorldPort 和 Provider Governor 中。Provider 返回值先持久化为 artifact，再经过商品身份、资格、Source Fact 和 EvidenceRef，只有晋级后的 Claim 才能进入最终回复。最终 Goal、WorkingSet、AssistantMessage、Claim 和事件在 PostgreSQL 事务中原子发布，过期 attempt 会被 fencing 拒绝。
>
> 这个设计的取舍是优先一致性、事实安全和可审计性，而不是最大化 Agent 自主性。当前它是 API/Worker 双进程的模块化单体；未来只有在队列吞吐、数据规模或团队边界证明必要时，才考虑引入专用消息队列、向量召回或独立推荐服务。
