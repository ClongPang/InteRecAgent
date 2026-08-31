# InteRecAgent 项目架构定位与面试说明

本文面向高水平校招技术面试，目标不是罗列技术栈，而是说明：项目解决了什么问题、为什么这样分层、LLM 的权限边界在哪里，以及系统如何保证状态一致性与商品事实可信。

本文以当前 TypeScript Conversation Runtime 为准。内部资格测试、开发期抽样和故障注入结果只用于工程决策，不应包装成真实业务增长指标。

## 30 秒项目介绍

InteRecAgent 是一个面向跨境购物的有状态对话式推荐系统。它不是让大模型直接搜索商品并自由回答，而是采用“LLM 语义提案、确定性系统执行”的架构：pi-agent 负责理解用户语言、提出结构化 `TurnPlan` 和组织回复；计划规范化器、Conversation Policy 与受策略约束的话轮执行器负责计划冲突消解、状态变更、外部调用授权、商品来源校验和回复发布。系统使用 PostgreSQL 持久化 Conversation、Turn、WorkingSet、Claim 和 Evidence，通过独立 Worker、lease、fencing 与事务实现可恢复、可审计的话轮处理。

## 一句话架构定位

> 以 PostgreSQL 为权威状态源、以可恢复 Turn 为执行边界、以 pi-agent 为受约束计划生成器、以确定性话轮执行器为业务裁决边界的来源可追踪对话推荐系统。

更完整的工程标签是：

- TypeScript 模块化单体；
- API/Worker 双进程运行拓扑；
- PostgreSQL-backed recoverable turn processing；
- DDD-influenced + Ports and Adapters；
- Schema/Policy 驱动的单 Agent；
- Evidence-backed response with claim-level provenance；
- 版本化状态 + Transactional Outbox + SSE Projection；
- 离线任务评测、指标回归门禁与运行链路观测。

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
Recoverable Turn Worker
        │ bounded ConversationSnapshot
        ▼
fresh pi-agent ───────────────► DeepSeek / OpenAI
        │ TurnPlanProposal
        ▼
model-facing schema / source grounding
        ▼
Plan Normalizer
        ▼
Conversation Policy
        ▼
Policy-Enforced Turn Executor
        │
        ├── Goal / Dialogue / WorkingSet reducers
        ├── referent binding / undo / local reranking
        ├── Claim / Evidence / disclosure verification
        └── ShoppingDataPort
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
Executor validation + atomic revision publication
        │
        ▼
PostgreSQL Message / State / Event / Outbox
        │
        └── SSE ──► UI projection refresh
```

## 分层与依赖方向

| 模块 | 架构职责 | 关键内容 |
| --- | --- | --- |
| `packages/domain` | 确定性领域内核 | Goal、WorkingSet、TurnPlan、候选规则校验、排序、回复声明来源一致性校验 |
| `packages/agent` | AI 与业务之间的适配层 | 上下文投影、pi-agent 协议、TypeBox Schema、计划规范化器、话轮执行器 |
| `packages/runtime` | 应用运行时和基础设施 | Worker、PostgreSQL Repository、商品搜索服务、Provider 调用控制、Telemetry |
| `packages/api` | 接入层 | JWT、REST、ConversationProjection、SSE |
| `frontend` | 用户交互层 | 对话输入、候选展示、比较、进度、失败重试 |
| `spec` / `scripts` | 质量控制面 | 产品契约、评测设计、协议负向测试、故障验收、指标回归检查 |
| `ops` | 运维面 | OpenTelemetry、Langfuse、Prometheus、Grafana |

主要依赖方向为：

```text
domain ← agent ← runtime ← api

frontend ── HTTP/SSE ──► api
```

领域层不依赖 Fastify、PostgreSQL 或具体模型 Provider；话轮执行器通过内部端口 `ShoppingDataPort` 调用商品搜索与来源服务，Runtime 再提供 PostgreSQL、BuyWhere 和 FX 的具体适配器。

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

“第二个”“这款”“刚才比较的两个”不能由模型根据自由文本猜测，而是由话轮执行器在当前 WorkingSet 上绑定。

### 回复声明与来源记录

模型不能直接发布“有货”“更便宜”“来自美国市场”等商品信息。项目内部使用以下来源追踪链路：

```text
Provider Artifact
  → Source Listing
  → Rule-resolved Product Identity
  → Candidate Eligibility Check
  → Normalized Source Field
  → EvidenceRef
  → Grounded Claim
  → AssistantEnvelope
```

这是一种基于来源充分性的白名单发布：不是发现已知坏结果后排除，而是只有能回溯到允许来源、且与当前候选一致的信息声明才允许发布。这里的 `Grounded Claim` 表示来源一致，不表示 Provider 数据已经被第三方核实为现实真值。

## Worker、pi-agent、计划规范化器与话轮执行器的边界

### Worker：执行生命周期控制器

Worker 是独立运行的 TypeScript 后台进程，负责：

- 从 PostgreSQL 领取 Turn；
- 建立 lease、heartbeat 和 fencing；
- 加载指定 revision 的 ConversationSnapshot；
- 创建本轮商品搜索适配器、话轮执行器和 fresh pi-agent；
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
- 协议修复与确定性降级回复；
- Telemetry 事件订阅。

pi-agent 负责“理解、提案、表达”，不拥有数据库、商品世界或最终发布权。

### 计划规范化器：结构化计划冲突消解与机械派生

模型先提出结构化操作计划，计划规范化器再对计划做冲突消解和有限派生。代码中的内部标识仍为 `compileTurnIntent`，但它不重新执行自然语言意图识别，也不是通用语义编译器。它负责：

- 按消息来源和操作顺序消解同一 Goal 字段的冲突；
- 保留最新的有效修改；
- 从已经明确的持久语义派生机械后果；
- 保证“状态变化”与“展示变化”一致。

例如用户要求价格优先时，模型只能提出持久语义：

```text
GOAL_UPSERT_PREFERENCE(price)
```

计划规范化器可以进一步派生仅由执行器触发的操作：

```text
RERANK_WORKING_SET(price)
```

计划规范化器不重新解析用户自然语言，也不为模型补造缺失意图。

### 话轮执行器：确定性业务执行与裁决边界

代码中的内部类型 `ConversationTurnExecutor` 对外统一表述为：

> Policy-Enforced Turn Executor，受策略约束的确定性话轮执行器。

它负责：

- 校验和规范化模型提案；
- 将 Goal 操作绑定到原始用户消息；
- 稳定候选指代；
- 应用 Conversation Policy；
- 执行 Goal、WorkingSet 和候选/搜索操作；
- 控制 Provider 调用授权；
- 生成 Operation Receipt；
- 验证 Claim、Evidence、Question 和 Disclosure 白名单；
- 触发 attempt draft 保存和最终原子提交。

该执行器不是物理服务器，也不是独立进程，而是 Worker 为每个 Turn 创建的确定性应用服务对象。

## pi-agent 的 plan–execute–respond 协议

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

话轮执行器校验后按顺序执行操作，并返回：

- `claimIds`；
- `questionSlotIds`；
- `disclosureCodes`；
- 结构化 `publicResult`；
- 每个操作的状态。

### publish_reply

模型只能根据 receipts 中允许的 ID 组织项目内部的结构化回复对象 `AssistantEnvelope`，不能直接抄写或创造商品信息。话轮执行器会补充必要披露、生成确定性问题措辞并重新验证完整回复。

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
计划规范化器：怎样消解冲突与派生机械后果
Policy：当前状态是否允许
话轮执行器：怎样执行与验证
Repository：是否允许最终提交
```

#### 为什么不直接把完整对话历史交给模型？

核心问题不只是对话变长后“放不下”，而是原始消息只记录了“曾经说过什么”，不能唯一表示“当前应该执行什么”。多轮购物任务中会同时存在早期约束、后续修正、已经失效的要求、候选展示顺序以及外部检索结果；如果每轮都要求模型从完整历史中重新推导当前状态，状态正确性就会依赖一次概率性重建。

本项目因此把 PostgreSQL 中带版本的 ConversationSnapshot 作为跨轮权威状态，fresh pi-agent 不继承上一次进程内消息，而是每轮重新接收面向当前任务的结构化投影：Goal、待澄清项、待处理操作、WorkingSet、焦点与比较关系、当前消息、最近相邻对话和运行时能力。其针对关系如下：

| 问题 | 对应设计 | 作用 |
| --- | --- | --- |
| 历史中混有已被后续话轮覆盖的约束 | 从指定 `baseRevision` 加载 ConversationSnapshot | 不让模型自行判断哪一版状态仍然有效 |
| 消息与候选持续累积 | 只投影当前决策所需字段，并限制历史消息与候选摘要规模 | 控制模型输入增长和无关噪声 |
| “第一个”“这款”等指代依赖当前展示状态 | 模型保留 `DISPLAY_RANK` 等指代，话轮执行器再依据当前 WorkingSet 绑定稳定 `offerRef` | 避免模型凭文本猜测候选身份 |
| Worker 重启、接管或 attempt 重试 | 每次从持久化快照创建 fresh pi-agent | 恢复结果不依赖某个进程中的隐式记忆 |

这也是为什么没有采用以下方案作为权威上下文：

- 完整历史追加：保留信息最全，但状态仍是隐式的，输入规模随轮次增长；
- 仅保留最近 N 轮：成本固定，但可能丢掉较早提出、目前仍然有效的预算或规格约束；
- 自由文本摘要：适合压缩叙述，不适合精确保留约束版本、候选关系和证据引用，也较难审计与回滚；
- 向量记忆或 RAG：解决的是语义召回问题，不负责当前状态、候选身份和版本一致性。

当前实现位于 `packages/agent/src/context.ts`，采用固定字段投影和近似预算：当前消息最多 8 条、单条最多 2500 字符，最近相邻消息最多 2 条、单条最多 2000 字符，WorkingSet 最多投影 20 个候选；默认按 `JSON.stringify(...).length / 4` 估算 8000 Token，超限时先裁剪候选尾部，再移除最近相邻对话，仍超限则拒绝执行。该预算只覆盖 Conversation Context 本身，并不等价于对 System Prompt、工具 Schema、工具回执和后续模型轮次的端到端精确 Token 管理。

更完整的目标方案是在真实 tokenizer 计数基础上，把 System Prompt、工具 Schema、结构化状态、候选摘要和工具回执纳入统一预算，并明确不可裁剪项与裁剪优先级。完成这一演进后，才适合在简历中表述为：

> 多轮购物任务中，以会话快照维护跨轮任务状态，在 Token 预算内按业务优先级组织目标约束、待处理事项、候选关系与证据引用，并由执行层完成候选指代解析。

如需证明方案有效，应使用完整历史追加作为基线，至少评估：模型实际输入 Token、跨轮目标状态正确率、候选指代解析准确率，以及 Worker 重启或接管后的结果一致率。Token 降低只能证明成本受控，目标状态和指代正确率不下降，才能证明上下文管理没有以损失任务质量为代价。

#### 已完成的开发集消融测试

项目已增加 `spec/evaluation/context-ablation-v1/cases.json` 和成对运行脚本，对 12 个预登记多轮状态/指代任务分别执行 3 次结构化投影与 3 次全量历史基线，共 72 个真实模型 trial。两组使用相同模型、System Prompt、工具 Schema、初始会话快照和 Gold；全量历史组只额外回灌截至当前轮的完整历史。Token 采用模型供应商返回的 usage，总有效输入按 `input + cacheRead + cacheWrite` 计算，不使用字符数估算。

| 指标 | 结构化投影 | 全量历史基线 | 结论 |
| --- | ---: | ---: | --- |
| 总有效输入 Token | 739,093 | 777,611 | 降低 5.0% |
| 单 trial 有效输入 Token p50 | 20,459 | 21,537 | 降低 5.0% |
| 单 trial 有效输入 Token p95 | 20,846 | 21,892 | 降低 4.8% |
| 未缓存输入 Token 总量 | 47,509 | 66,571 | 降低 28.6% |
| 多轮约束状态正确 | 36/36（100%） | 36/36（100%） | 开发集无回退 |
| 候选指代正确 | 46/48（95.8%） | 46/48（95.8%） | 开发集无回退 |

供应商 usage 将未缓存输入、缓存读取和缓存写入分开报告。总有效输入按 `input + cacheRead + cacheWrite` 计算，因此当前证据支持的准确说法是：“开发集消融中，相比额外回灌完整历史，结构化上下文将总有效输入 Token 降低 5.0%、未缓存输入降低 28.6%，多轮约束状态保持 36/36、候选指代保持 46/48。”不能只取 28.6% 并称为全部输入降幅，也不能改写成“正确率提升”。两组缺失的 2 个指代对象来自同一次模型遗漏 `SET_COMPARISON`，不是把序数绑定到了错误候选。

##### `46/48` 的失败归因：操作遗漏，而非错误绑定

失败任务要求比较第一、第三个展示候选的价格与库存。Gold 将该意图拆成两类语义效果：

```text
SET_COMPARISON(first, third)                 # 持久化本轮比较关系
INSPECT_WORKING_SET(first, third, PRICE, STOCK) # 读取回答所需事实
```

在同一测试任务的一次重复中，结构化投影与全量历史两组都只生成了 `INSPECT_WORKING_SET`。第一、第三个候选均被正确解析为稳定的 `offerRef`，模型可以取得本轮回答所需事实，但没有提出 `SET_COMPARISON`，所以没有把比较关系写入会话状态。每组由此遗漏 2 个属于 `SET_COMPARISON` 的 Gold referent，形成 `46/48`。

这说明失败不在 `DISPLAY_RANK → offerRef` 的确定性解析，而在“开放语义是否完整映射为领域操作”：

1. `INSPECT_WORKING_SET` 足以回答本轮价格和库存问题，模型选择了较短的即时回答路径；
2. `SET_COMPARISON` 的价值是持久化 `comparisonOfferRefs`，供后续“这两款”等指代继续使用，当前 Prompt 没有明确规定显式比较必须同时提交该操作；
3. 话轮执行器遵守“只执行模型明确提出的语义操作”，不会根据“检查了两个候选”擅自推断用户要求持久化比较关系；
4. 两种上下文策略出现相同遗漏，而且已生成操作中的候选均解析正确，因此不能把它归因于上下文裁剪。

严格来说，当前 `46/48` 衡量的是**候选指代目标覆盖率**，混合了操作召回与引用绑定两个环节，不宜直接命名为“候选绑定准确率”。本轮错误结构是：

```text
Gold 指代目标：48
正确覆盖：46
错误绑定：0
操作遗漏导致的未覆盖：2
```

面试时应表述为：“开发集候选指代目标覆盖 46/48；失败来自模型遗漏比较状态写入，已执行指代未观察到错误候选绑定。”如果产品定义要求每次显式比较都持久化比较关系，应在冻结下一版评测前先确定一种方案：由 Prompt 明确要求 `SET_COMPARISON + INSPECT_WORKING_SET`，或由计划规范化器仅在原文明确表达比较意图时派生比较状态。不能在看到本轮成绩后直接删除 Gold 要求，否则会造成评测口径污染。

完整结果见 `docs/acceptance/context-ablation-development-result.md`。该测试仍标记为 `eligibleForResumeMetrics: false`：用例和 Gold 由开发侧编写，可用于面试中说明评测方法和开发集结果；如要作为不带限定的正式简历指标，还需由独立评审者冻结题目与 Gold 后复跑，避免调参和选题污染。

#### 第二条简历 Bullet：结构化规划与工具授权

目标表述（补齐字段级来源、显式依赖校验和外调幂等审计后使用）：

> 针对复合购物需求中状态变更、候选操作与外部检索混杂，直接工具调用易产生顺序冲突、无依据参数和越权外调；在 pi-agent 工具循环上引入声明式 TurnPlan，LLM 仅提交带来源的有序操作，确定性执行层完成冲突消解、依赖校验、Policy 授权与幂等外调，模型仅依据执行回执发布回复；6 类 30 项负向测试全部按预期拦截或降级。

这条与第一条的分工是：第一条回答“多轮上下文如何保持稳定”，第二条回答“模型提出的动作如何安全落地”。当前代码已经具备 `commit_turn_plan → ordered operations → publish_reply` 两阶段工具流、TypeBox 计划约束、操作顺序与冲突规范化、部分原文来源校验、Policy/调用预算授权、执行回执和 Claim 引用校验。尚需补齐以下能力，才能完整支撑上面的目标表述：

- 为所有可能触发状态变化或外调的参数记录字段级来源，而不只覆盖 Goal 类操作；
- 将操作间前置条件和依赖关系显式化，区别于当前主要依靠数组顺序与冲突规则；
- 持久化可审计的 Policy 决策，并用稳定幂等键证明 Provider 重试不会重复产生副作用；
- 由独立评审者冻结用例与预期结果后复跑，避免开发集调参与选题偏差。

当前 `30/30` 来自 6 类、每类 5 项的确定性协议负向测试，覆盖越阶段调用、重复提交、非法来源序号、无依据目标来源、缺少工具回执和非法 Claim 引用；它证明执行边界按预期拒绝或受控降级，不应表述为真实模型对抗测试，也不能替代“必需操作执行覆盖率”等任务完成度指标。

## 外部系统的信任边界

| 参与者 | 可以做什么 | 不能做什么 |
| --- | --- | --- |
| LLM | 理解语言、提出计划、组织回复 | 直接写状态、授权 Provider、创造商品事实 |
| pi-agent | 运行模型/工具循环 | 决定领域规则和数据库提交 |
| 计划规范化器 | 规范化已提出的操作并消解冲突 | 从原始文本发明新意图 |
| 话轮执行器 | 校验、执行、生成 receipts、验证发布 | 绕过 Repository 强制提交 |
| BuyWhere | 提供发现型商品观察 | 自动证明销售地、配送资格和最终可购买性 |
| FXRates | 提供带时间边界的汇率观察 | 决定最终结算金额 |
| PostgreSQL | 保存权威状态、证据和执行边界 | 理解自然语言 |

这里有两个不信任边界：

1. 模型输出是不可信提案，必须经过 Schema、参数来源检查、计划规范化、Policy 和话轮执行器；
2. Provider 输出是不可信观察，必须经过 artifact 持久化、身份识别、资格校验和 Evidence/Claim 晋级。

## 一次自然语言 Turn 的完整链路

以“预算 3000 元，在美国找一款降噪耳机”为例：

1. React 调用 Fastify API 提交 Message；
2. API 验证 JWT，将 Message 与 Turn 写入 PostgreSQL，返回 `202 Accepted`；
3. Worker 使用 `FOR UPDATE SKIP LOCKED` 领取 Turn；
4. Worker 建立 lease、heartbeat、attempt 和 fence token；
5. Worker加载指定 `baseRevision` 的 ConversationSnapshot；
6. Worker 创建商品搜索适配器、Repository Turn Session 和话轮执行器；
7. Worker 将有界上下文交给 fresh pi-agent；
8. 模型通过 `commit_turn_plan` 提出目标、预算、市场、约束和研究操作；
9. 话轮执行器执行参数来源检查、计划规范化、指代稳定和 Conversation Policy；
10. Policy 授权最多一次逻辑研究；
11. 商品搜索服务优先检查本地候选缓存，否则通过 Provider 调用控制器调用 BuyWhere 与 FX；
12. Runtime 保存 artifact、规范化来源字段、候选校验结果、来源引用和 WorkingSet；
13. 话轮执行器返回只包含允许发布的 Claim ID 的 receipts；
14. 模型通过 `publish_reply` 组织回复；
15. 话轮执行器验证 Claim/Evidence 的来源一致性和必要披露；
16. Repository 在一个事务中提交 Goal、Dialogue、WorkingSet、AssistantMessage、Claim 和 Event；
17. API 通过带 cursor 的 SSE 发送事件；
18. 前端重新加载 ConversationProjection。

结构化 UI 输入如 `PATCH_GOAL`、`UNDO` 和 `SET_COMPARISON` 可以绕过 LLM，直接构造确定性计划交给话轮执行器。这说明 LLM 是自然语言入口，不是所有业务操作的必经核心。

## 为什么使用基于 PostgreSQL 租约的可恢复 Worker，而不是 Redis 队列

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

- `VERIFIED`（内部枚举）：表示已配置品类规则，并完成型号、主商品/配件、成色和市场校验；不表示商品已获第三方认证；
- `DISCOVERY`（内部枚举）：表示只提供开放品类搜索、规则排序和反馈；身份不足时保持 `OFFER_ONLY`，即只确认到报价记录。

这种设计将“语言理解能力”与“品类事实验证能力”分离。扩展新品类时优先增加数据契约、商品目录和证据源，而不是复制 Prompt 或创建新的品类 Agent。

## 质量与评估体系

项目将 AI 评估视为独立架构面，而不只依靠单元测试：

- 产品不变量和多轮轨迹契约；
- Domain、话轮执行器与协议单元测试；
- PostgreSQL/API 集成测试；
- 预登记评测设计与任务评估；
- 协议负向测试；
- 故障注入和运行验收；
- Provider replay fixture；
- 模型与服务契约变更检查；
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

系统能够回答某项回复信息来自哪个 Provider artifact、哪次检索轮次、哪个规范化来源字段和哪次 revision。

## 当前限制与演进方向

### 话轮执行器复杂度

内部类型 `ConversationTurnExecutor` 当前同时承担参数来源检查、指代处理、计划规范化、状态执行、恢复与发布验证，代码规模正在接近大型应用服务。后续可以在保持统一权限边界的前提下拆为：

```text
ProposalGrounder
PlanNormalizer
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

因为模型可以提出“是否需要重新搜索商品”，但不能拥有 Provider 授权、租户配额、请求幂等和来源字段发布权。话轮执行器与 Provider 调用控制器统一实现预算、并发、熔断、来源记录持久化和审计。

### pi-agent 被修改了吗？

没有。项目使用标准依赖，通过公开的模型、工具、Hook、事件和停止条件接口适配。新增的是项目自己的 Prompt、TypeBox Schema、plan–execute–respond 协议、计划规范化器和话轮执行器。

### 模型为什么知道 `RESEARCH_OFFERS`？

因为它出现在 `commit_turn_plan` 的参数 Schema 中，System Prompt 说明适用语义，Conversation Context 提供当前状态。模型只获得提案能力，话轮执行器才拥有执行授权。

### 为什么文档不再把 `Host` 当作专业架构名称？

`Host` 是代码中的历史内部命名，在 MCP 等体系中另有明确含义。本项目对象既不是 MCP Host，也不是独立宿主进程；对外统一称为“Policy-Enforced Turn Executor，受策略约束的话轮执行器”，需要定位代码时再补充内部类型名 `ConversationTurnExecutor`。

### 为什么每个 Turn 创建 fresh pi-agent？

持久状态已经由 PostgreSQL ConversationSnapshot 管理。每次创建 fresh agent 可以避免把进程内模型历史误当作权威状态，保证 attempt 重试从同一个 `baseRevision` 开始，并降低跨租户或跨 attempt 的隐式状态泄漏。

### 如何防止模型幻觉？

不是试图消除模型生成错误，而是限制错误的影响范围：Schema 限制语法，原文 span 检查限制参数来源，计划规范化器限制派生，Policy 限制外调，话轮执行器限制状态变化，ClaimVerifier 校验回复声明与来源记录的一致性，Repository 限制最终提交。

### 这是微服务吗？

不是。它是一个 npm workspaces 模块化单体，在运行时拆成 API 和 Worker 两个进程，共享领域包、Runtime 和 PostgreSQL。这个拆分是执行拓扑隔离，不是独立服务自治。

### 这是 Event Sourcing 吗？

不是纯 Event Sourcing。项目直接持久化版本化 ConversationState、消息和领域记录，同时写入事件与 Outbox，用于通知、审计和 Projection cursor。

## 面试表达红线

不要说：

- “大模型负责做推荐和调用所有外部工具”；
- “系统实现了全链路 exactly once”；
- “这是微服务、多 Agent 或 Event Sourcing”；
- “BuyWhere 返回的就是已经核实的现实商品事实”；
- “用了内部评估结果，所以线上推荐效果提升了某个百分比”；
- “用了 Langfuse 就解决了模型评估问题”；
- “使用 PostgreSQL 是因为 Redis 不可靠”。

建议说：

- “LLM 负责开放语义，确定性系统负责业务裁决”；
- “外部调用允许重试，正式状态采用 fencing 保护的事务发布”；
- “BuyWhere 是商品搜索来源，回复中的商品信息必须通过来源引用与候选一致性校验”；
- “当前选择 PostgreSQL 是一致性、审计和基础设施复杂度之间的阶段性权衡”；
- “评估区分协议、事实安全和业务完成度”。

## 代码导览

| 主题 | 入口 |
| --- | --- |
| pi-agent 适配与 System Prompt | `packages/agent/src/turn-agent.ts` |
| plan–execute–respond 协议 | `packages/agent/src/protocol.ts` |
| 模型侧 TypeBox Schema | `packages/agent/src/schemas.ts` |
| Conversation Context 投影 | `packages/agent/src/context.ts` |
| 计划规范化器（内部文件名沿用 intent-compiler） | `packages/agent/src/intent-compiler.ts` |
| 话轮执行器（内部文件名沿用 conversation-turn-executor） | `packages/agent/src/conversation-turn-executor.ts` |
| Conversation Policy | `packages/domain/src/conversation-policy.ts` |
| Turn Worker | `packages/runtime/src/conversation-worker.ts` |
| Repository Turn Session | `packages/runtime/src/repository-turn-session.ts` |
| 商品搜索与来源适配器（内部文件名沿用 conversation-offer-search-service） | `packages/runtime/src/conversation-offer-search-service.ts` |
| PostgreSQL Repository | `packages/runtime/src/postgres-conversation-repository.ts` |
| 商品来源追踪与声明校验 | `packages/runtime/src/search-provenance.ts` |
| Fastify API/SSE | `packages/api/src/app.ts` |
| 前端 Projection 消费 | `frontend/src/App.tsx` |

## 两分钟面试讲述版本

> 我做的是一个跨境购物场景的多轮对话推荐系统。它最核心的设计不是接入了哪个模型，而是把概率性的语言理解和确定性的业务执行分开。
>
> 系统把 Conversation 作为长期购物任务，把 Turn 作为可租约、重试、取消和审计的持久执行边界。用户消息先由 Fastify API 写入 PostgreSQL，Worker 再通过 lease 和 fence 领取 Turn。每个 attempt 都从指定 revision 的快照创建 fresh pi-agent。
>
> pi-agent 没有被修改，只作为通用模型与工具循环。模型只看到 `commit_turn_plan` 和 `publish_reply` 两个工具。它通过 TypeBox Schema 知道可以提出哪些领域操作，通过 System Prompt 知道何时使用，通过结构化 Conversation Context 知道当前 Goal 和 WorkingSet。模型提交的计划还要经过原文依据校验、计划规范化和 Conversation Policy，最后由确定性话轮执行器执行。
>
> 外部 BuyWhere 和汇率服务不直接暴露给模型，而是位于话轮执行器后面的内部端口和 Provider 调用控制器中。Provider 返回值先持久化为 artifact，再经过规则身份解析、候选准入、规范化来源字段和 EvidenceRef，只有通过来源一致性校验的 Claim 才能进入最终回复。最终 Goal、WorkingSet、AssistantMessage、Claim 和事件在 PostgreSQL 事务中原子发布，过期 attempt 会被 fencing 拒绝。
>
> 这个设计的取舍是优先一致性、事实安全和可审计性，而不是最大化 Agent 自主性。当前它是 API/Worker 双进程的模块化单体；未来只有在队列吞吐、数据规模或团队边界证明必要时，才考虑引入专用消息队列、向量召回或独立推荐服务。
