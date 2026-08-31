# 对话式 Agent 的澄清、不确定性与可回答性：相似场景技术调研

日期：2026-08-30  
用途：P3「不确定性归属与 Answerability」的设计输入，不作为新增 badcase 规则清单。

## 1. 调研问题

当前问题表面上是回复“请再补充一个关键选购条件”缺少可选方向，根因却不是文案不够丰富，而是系统没有稳定区分：

1. 用户的意图存在多个合理解释；
2. 完成推荐确实缺少只能由用户提供的信息；
3. 用户的问题明确，但搜索结果没有库存、保修等事实证据；
4. 模型协议、工具、网络或运行时失败。

如果这四类状态共享一个 `REQUEST_CLARIFICATION` 或通用 rephrase fallback，系统就会把自身失败或证据缺失包装成用户表达不清。继续给原句增加例子只能改善一次话术，不能修复错误归因。

## 2. 相似系统形成的共识

### 2.1 澄清只解决“问题含义不确定”，不能解决“答案事实未知”

《Selectively Answering Ambiguous Questions》把不确定性明确分为：

- denotational uncertainty：对问题含义或指代不确定；
- epistemic uncertainty：问题含义清楚，但知识库没有足够信息确定答案。

论文建议先处理歧义，再对有足够置信度的问题选择性回答；其关键价值不是具体置信度算法，而是证明“问题不明确”和“答案不知道”需要两条不同处理路径。论文还报告，简单要求模型自我验证或允许它回答 unknown，并不足以形成可靠的选择性回答机制。

来源：[Selectively Answering Ambiguous Questions, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.35/)

RAG 场景也形成了相同边界。UAEval4RAG 将 underspecified 与 out-of-database 分成不同不可回答类别，并分别评估直接回答、请求澄清和拒绝/不回答的比例。这说明检索系统不能用统一 fallback 吞掉不同的不可回答原因。

来源：[Unanswerability Evaluation for Retrieval Augmented Generation](https://arxiv.org/abs/2412.12300)

### 2.2 “是否提问”是有用户成本的决策，不是缺槽位即提问

澄清问题研究使用 Expected Value of Perfect Information：只有用户回答预计能显著改善后续任务时，问题才有价值。这与固定 slot-filling 不同；一个字段不存在，不代表值得打断用户。

来源：[Learning to Ask Good Questions, ACL 2018](https://aclanthology.org/P18-1255/)

更近期的 IntentSim 工作把是否澄清描述为用户对速度/易用性与谨慎程度的权衡，并估计多个可能用户意图的分布。若一个解释占明显优势，可以基于可披露假设继续；若多个解释会导致显著不同的推荐行为，才值得澄清。

来源：[Clarify When Necessary, NAACL Findings 2025](https://aclanthology.org/2025.findings-naacl.306/)

因此，本项目中的“关键选购条件”不应是一个静态字段列表。它应满足三个条件：用户可回答、会改变候选准入/排序/搜索范围、其预期收益高于额外一轮对话的成本。

### 2.3 推荐 Agent 不应无限采集偏好

对话式推荐研究发现，多轮中用户回答更多偏好问题，推荐质量反而可能下降。这提示系统不能把“多问几轮”当作天然更精确；需要评估每轮偏好采集的边际价值，并在已有信息足以搜索时先给可用结果、再支持渐进式 refinement。

来源：[A Flash in the Pan, COLING 2025](https://aclanthology.org/2025.coling-main.561/)

混合主动式会话检索也把任务定义为：对 underspecified 或 ambiguous 查询，从上下文和检索内容中选择下一条澄清问题，而不是生成泛化的“请补充更多信息”。这支持“提问需要绑定具体缺口和当前上下文”。

来源：[Conversational Search with Mixed-Initiative, DialDoc 2022](https://aclanthology.org/2022.dialdoc-1.7/)

### 2.4 成熟对话平台把用户输入错误与系统错误建模为不同事件

Google Conversation Design 区分 `No Match` 与 `System error`：前者是无法解释用户输入，后者是用户已被正确理解，但依赖系统不能完成任务。Dialogflow CX 也分别提供 no-match/no-input 事件与 webhook error 事件。两者均不把后端错误路由到用户重述。

来源：[Google Conversation Design: Errors](https://developers.google.com/assistant/conversation-design/errors)、[Dialogflow CX state handlers](https://docs.cloud.google.com/dialogflow/cx/docs/concept/handler)

该模式直接否定了“模型协议失败 -> `TURN_REPHRASE`”的设计。

### 2.5 Agent 自主规划与确定性审批可以共存

结构化输出保证 schema 形状，但官方说明它不能防止字段值或步骤本身出错。因此，严格 schema 不能代替业务语义审批。

来源：[OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/)

OpenAI Agents SDK 将 guardrail 放在模型输入、模型输出和工具调用边界，并允许阻断、替换或抛出 tripwire。这支持“Agent 生成语义计划，确定性边界负责授权”的职责划分，而不是让宿主重新生成另一份计划。

来源：[OpenAI Agents SDK Guardrails](https://openai.github.io/openai-agents-python/guardrails/)

Anthropic 对 workflow 与 agent 的区分也提供了边界：Agent 动态决定过程和工具使用；预定义代码路径提供可预测性。其 evaluator-optimizer 模式适合有清晰评判标准的有界反馈循环，而不是无限自我反思。

来源：[Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

## 3. 候选技术方案与否定审查

| 方案 | 优点 | 被否定的根因 |
|---|---|---|
| 给“请补充条件”增加类目例子 | 改动快 | 只改文案；继续积累类目和句式 badcase；系统失败仍可能进入此回复 |
| 固定 slot-filling 规则 | 行为稳定 | 把所有空字段当成阻塞字段，无法衡量用户成本和决策价值，容易过度追问 |
| 模型自行判断低置信度后提问 | 开放域能力强 | 自报置信度不稳定；模型同时成为提案者和授权者；容易混淆语义不确定与证据未知 |
| 独立 LLM judge 决定是否允许提问 | 比单模型多一次检查 | judge 仍可能语义漂移，并成为第二个 planner；适合 shadow/eval，不适合作为唯一生产授权 |
| 每个错误码各写一个 fallback | 可覆盖已知故障 | 把运行时演化成 badcase 路由表；新的错误仍会错误归因 |
| **类型化不确定性 + 计划审批 + 执行后 Answerability** | 归因可审计，保留 Agent 开放域语义能力，确定性控制执行和发布 | 需要协议、测试和观测一起迁移；这是推荐方案 |

## 4. 推荐架构

推荐采用单一职责链：

```text
用户消息
  -> Pi-Agent 提出 TurnPlan，并为澄清操作声明可解析的不确定性
  -> ClarificationPolicy 审批：该缺口是否用户可解决、是否值得打断
  -> 只有 APPROVED 计划执行
  -> 工具 receipts 形成实际证据状态
  -> Answerability 根据“已批准操作 + receipts”决定发布模式
  -> 渲染器把结构化决定转成自然语言
```

### 4.1 使用四类不确定性，但不建立通用工作流 DSL

```ts
type UncertaintyType =
  | "INTENT_AMBIGUITY"
  | "MISSING_USER_INFORMATION"
  | "MISSING_EVIDENCE"
  | "SYSTEM_FAILURE";
```

处理权限固定为：

| 类型 | 谁能解决 | 合法动作 |
|---|---|---|
| `INTENT_AMBIGUITY` | 用户，或上下文中已有明确指代 | 澄清；若有占优解释且风险低，可披露假设后继续 |
| `MISSING_USER_INFORMATION` | 用户 | 仅在阻塞或高信息价值时澄清；否则搜索后渐进细化 |
| `MISSING_EVIDENCE` | 检索/数据源 | 补检索或披露未知；不得要求用户改写 |
| `SYSTEM_FAILURE` | 系统 | 有界重试或降级；不得创建澄清状态 |

这些类型是错误归属，不是新的 planner。Pi-Agent 仍决定它想采取哪些业务动作，policy 只判断这些动作是否可执行。

### 4.2 澄清审批需要验证“用户可解决的具体缺口”

每个 `REQUEST_CLARIFICATION` 至少要能审计：

- `uncertaintyType`：只能为前两类；
- `clarification`：注册过的业务含义，如目标商品、购买市场、候选指代；
- `decisionImpact`：回答可能改变搜索范围、候选准入、硬约束或排序中的哪一项；
- `reasonCode`：稳定机器码，仅用于审计；
- 当前状态中该信息确实未知，并且未被用户跳过。

首版不建议把信息价值做成模型生成的浮点分数。先用稳定业务条件审批：是否阻塞安全搜索、是否会改变硬约束、是否存在多个会导致不同动作的解释。模型概率、采样一致性或 IntentSim 风格熵估计可作为后续 shadow signal，不能成为唯一授权。

### 4.3 Answerability 必须位于工具执行之后

计划审批只能证明“准备做什么”合法，不能证明工具实际返回了证据。Answerability 应只消费批准计划和 receipts：

```ts
type AnswerabilityDecision =
  | { mode: "ANSWER"; claimIds: string[] }
  | { mode: "DISCLOSE_UNKNOWN"; factKinds: ClaimKind[] }
  | { mode: "RETRIEVE"; capability: string }
  | { mode: "CLARIFY"; clarification: ClarificationIntent }
  | { mode: "DEGRADE"; failureOwner: "SYSTEM"; errorCode: string };
```

关键不变量：

- receipt 中有可引用 claim，才允许发布对应事实；
- 请求库存/保修且 `unknownFields` 包含该事实时，稳定返回 `DISCLOSE_UNKNOWN`；
- 工具或模型协议失败稳定返回 `DEGRADE`；
- `CLARIFY` 必须引用已批准的澄清操作，Answerability 不得自行生成新业务计划；
- renderer 使用受控自然语言模板表达“当前来源没有提供库存信息”等内容，绝不直接显示 `STOCK_UNKNOWN`、`MODEL_PROTOCOL_FAILED`。

### 4.4 修复循环必须有界

PlanReview 返回结构化 violation，由原 Pi-Agent 修复提案。默认一次修复，第二次仍不合法则系统降级。这样保持 Agent 的规划权，同时避免无限反思和审查器静默改写语义。

## 5. 与当前代码的差距

1. `TurnAction.REQUEST_CLARIFICATION` 目前只有 `clarification + reasonCode`，没有可审计的不确定性归属和决策影响。
2. `evaluateClarificationDecision` 目前根据字段种类和状态决定 ASK/SKIP，但仍是计划变换链的一部分，尚未成为纯审批器。
3. `conversation-turn-executor.fallbackReply` 在没有计划或协议失败时会构造 `REQUEST_CLARIFICATION(TURN_REPHRASE)`，与主流错误分类相反。
4. 搜索服务已经产生 `unknownFields`，这是良好的证据边界；但随后主要转成内部 `*_UNKNOWN` disclosure code，尚无正式 Answerability 决策。
5. 回复发布具备 claim/disclosure 白名单基础，可复用为 Answerability 的执行边界，不需要再建一个回复 Agent。

## 6. P3 实施建议

建议保持既定 P0-P5 顺序，P3 内按以下次序实施：

1. 新增领域类型 `UncertaintyType`、澄清依据和 `AnswerabilityDecision`；
2. 扩展 `REQUEST_CLARIFICATION` schema，要求声明用户可解决的缺口；
3. 将 ClarificationPolicy 改成无副作用 reviewer，只返回批准或结构化 violation；
4. 实现执行后 Answerability，消费 approved plan、operation receipts、claim IDs 和 unknown fields；
5. 建立 disclosure code 到自然语言的受控渲染表，内部码只留在 trace；
6. 将系统失败路由到 `DEGRADE`，但旧 fallback 的完整删除留到 P4；
7. 添加持久化与指标，再运行单元、属性、PostgreSQL 和真实 Buywhere 多轮验收。

## 7. 验收设计

不能只测一句文案，应使用因果配对轨迹：用户消息相同，只改变系统/证据状态。

| 用户请求 | 环境差异 | 期望 |
|---|---|---|
| “第二个怎么样？” | 两个候选都可能被指代 | `INTENT_AMBIGUITY -> CLARIFY`，问题明确列出候选 |
| “帮我买一个通勤耳机” | 目标和市场已知，预算未知 | 先搜索或给候选，不因预算缺失阻塞 |
| “第二个有保修吗？” | 保修字段不存在 | `MISSING_EVIDENCE -> DISCLOSE_UNKNOWN` |
| 同上 | provider 超时 | `SYSTEM_FAILURE -> DEGRADE` |
| 自然语言计划输出 schema 非法 | 模型协议失败 | `SYSTEM_FAILURE -> DEGRADE`，无 pending clarification |

核心指标：

- `system_failure_as_clarification_total = 0`；
- `missing_evidence_as_clarification_total = 0`；
- `unknown_fact_assertion_total = 0`；
- clarification precision：发出的每个问题都能由用户回答且改变决策；
- unnecessary clarification rate：已有足够信息却打断搜索的比例；
- 多轮任务成功率、平均澄清轮数、用户跳过率；
- 对每个事实类型分别统计 answer / disclose unknown / system degrade，避免总指标掩盖错误归因。

## 8. 目标漂移检查

- Pi-Agent 仍提出每个自然语言话轮的有序计划：是。
- policy 只审批、不生成替代计划：推荐方案满足。
- 是否新增了类目、商品名或句式专用生产分支：否。
- 是否引入第二个可写状态路径：否。
- 是否仍可能把模型、证据或系统不确定性包装成用户问题：目标方案禁止；当前代码仍存在该路径，P3/P4 必须移除。
- 是否绕过 P2 的 ESCI 候选准入：否，Answerability 只消费已批准操作与已准入 receipts。
- 新概念是否符合领域共识：`denotational/epistemic uncertainty`、clarification、answerability、guardrail、expected information gain 均有研究或平台依据；项目对外代码采用更直观的四类 `UncertaintyType`，不新增自造 DSL。

结论：本次调研支持既定方向，无需改变 P0-P5 顺序。P3 应修复“错误归属和发布决策”这一结构问题，而不是扩充“关键选购条件”话术或维护 badcase 列表。
