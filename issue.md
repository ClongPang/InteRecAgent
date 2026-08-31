# OBS-TRACE-001：Agent Trace 缺少上下文与 Tool Call 因果链

## Issue 状态

- 状态：Resolved / Accepted（2026-08-29）
- 优先级：P0（阻碍 Agent 失败归因）
- 范围：Agent Runtime、OpenTelemetry、Langfuse、Experiment 可观测性
- 性质：可观测结构问题，不是 Langfuse UI 配置问题

## 背景

当前系统已经采集 `AGENT / GENERATION / TOOL / GUARDRAIL` Observation，具备模型、Prompt、token、费用、工具执行和安全拦截等基础信息，也能够将 Experiment Score、Dataset Run 与本地评测证据进行核对。

但真实查看 Trace 时，多个 Generation、Tool 和 Guardrail 主要以平铺节点出现，无法直观看到模型上下文以及 `tool_call → tool_result → next generation` 的因果关系。当前方案能够证明链路执行过，却不足以解释 Agent 为什么做出某个决策。

## 用户可见现象

一条 Trace 通常呈现为：

```text
execute-turn-attempt
├─ invoke-planner-model
├─ tool.commit-turn-plan
├─ tool.host-xxx
├─ invoke-planner-model
├─ tool.publish-reply
└─ validate-reply-evidence
```

主要问题：

1. 看不到每次 Generation 真正收到的完整消息上下文。
2. 看不到模型生成的 `tool_call_id`。
3. 看不到与该 ID 对应的模型可见 `tool_result`。
4. 无法判断某个 Tool Result 是否进入了下一次 Generation。
5. 模型 Tool、Host 内部操作和 Provider 调用混在同一层。
6. 多次 Generation 都叫 `invoke-planner-model`，无法区分规划、结果消费、协议修复和最终回答。
7. Experiment Score 位于 wrapper Trace，业务执行位于 Turn Trace，失败分数无法直接下钻到因果节点。

## 根因证据

### 1. Agent 事件包含 Tool 信息，但遥测桥接器没有处理

`pi-agent-core` 已提供以下事件：

- `tool_execution_start`
- `tool_execution_end`
- `toolCallId`
- `toolName`
- `args`
- `result`
- `isError`

当前 [`createAgentEventObserver`](packages/runtime/src/telemetry.ts) 只处理：

- `turn_start`
- assistant `message_start`
- `turn_end`

因此 Tool Call 的开始、结果及关联 ID 没有进入 Langfuse。

### 2. Tool Protocol 主动丢弃了 `toolCallId`

[`ConversationToolProtocol`](packages/agent/src/protocol.ts) 的 Tool 执行签名使用：

```ts
execute: async (_toolCallId, params, signal) => { ... }
```

`_toolCallId` 被忽略，后续 Host、Provider 和数据库 Span 无法继承模型调用 ID。

### 3. Generation Input 不是实际模型上下文

当前每次 Generation 记录的输入来自 Worker 预先构造的摘要：

```json
{
  "currentUserMessages": [],
  "stateRevision": 0
}
```

它没有覆盖最终发送给模型的：

- System Prompt
- 历史消息窗口
- assistant `tool_call`
- `tool_result`
- 当前可用 Tool Schema
- Projected Conversation Context
- ResearchWave 引用

而且每次推理复用同一份摘要，第二次 Generation 无法展示它实际消费的 Tool Result。

### 4. `turn_end.toolResults` 未被采集

`turn_end` 事件同时携带 assistant message 和 `toolResults`。当前实现只把 `message.content` 写入 Generation Output，忽略 `toolResults`，因此消息链在 Langfuse 中断裂。

### 5. 存在两套没有关联主键的 Tool 观测

- Agent Loop 知道模型 Tool Call 和 `toolCallId`。
- Runtime `observeTool` 知道 Host/Provider 的实际执行情况。

两者没有共享 `toolCallId`，造成“模型调用流”和“系统执行流”并排存在，无法自动拼接。

### 6. Trace 边界仍存在展示风险

当前 enqueue 和 worker 通过确定性的合成 `parentSpanId` 进入同一 Trace，但对应父 Span 并未真实创建。不同 Exporter/UI 可能将它展示为多个根节点或 orphan Observation。

同一个用户 Turn 的不同 attempt 还会复用同一 Trace ID，失败 attempt、stale attempt 和最终成功 attempt 可能混在一起。

## 影响

### 故障定位

当业务评测失败时，只能看到模型、工具和 Guardrail 都运行过，无法确定：

- 模型是否看到了正确上下文。
- Tool Result 是否正确返回并进入下一轮推理。
- 错误来自模型规划、Tool 参数、Host 校验、Provider 数据还是状态发布。
- 第二次推理属于正常 Finalize 还是协议修复。

### 可复现性

原生 Prompt 版本只能锁定系统提示词，不能锁定完整推理输入。仅凭当前 Trace 无法重建一次模型调用。

### 可读性

Observation 数量增加后，信息密度并未提升，反而形成平铺的 JSON 和 Tool 节点。继续增加零散 metadata 会使问题更严重。

### Experiment 归因

Score 挂在 Experiment wrapper Trace，而一个测试用例可能触发多个业务 Turn Trace。目前依赖本地 artifact 完成二次关联，Langfuse 页面内不能从失败 Score 直接定位具体失败 Turn 和节点。

## 设计目标

一条 Trace 应当按 Agent Loop 的真实执行顺序展示：

```text
execute-turn-attempt                              AGENT
│
├─ planner.plan                                   GENERATION
│  ├─ input: system + context + user + tools
│  └─ output: tool_call(call_A, commit_turn_plan)
│
├─ commit_turn_plan                               TOOL
│  ├─ toolCallId: call_A
│  ├─ input: tool arguments
│  ├─ validate-plan                               SPAN
│  ├─ execute-operation                           SPAN
│  │  └─ search-provider                          TOOL
│  └─ modelVisibleResult: tool_result(call_A)
│
├─ planner.finalize                               GENERATION
│  ├─ input: assistant tool_call(call_A)
│  │         + tool_result(call_A)
│  └─ output: tool_call(call_B, publish_reply)
│
├─ publish_reply                                  TOOL
│  ├─ toolCallId: call_B
│  └─ modelVisibleResult: tool_result(call_B)
│
├─ verify-claims                                  GUARDRAIL
└─ commit-state-transition                        SPAN
```

目标不是采集模型隐藏推理过程，而是完整记录可观察的输入、调用、结果、状态迁移和证据决策。

## 方案设计

### 1. 在真实模型边界采集 Generation Context

不能从 `turn_start` 推测模型输入。应包装 `streamFn(model, context, options)`，在请求发送给 Provider 前采集最终 Context：

```ts
type GenerationContextSnapshot = {
  systemPrompt: PromptReference;
  messages: RedactedChatMessage[];
  tools: ToolSchemaReference[];
  model: string;
  modelParameters: Record<string, unknown>;
  contextSha256: string;
  toolSchemaSha256: string;
};
```

Langfuse Input/Output 使用标准 Chat Message 格式，而不是任意嵌套 JSON：

```json
[
  { "role": "user", "content": "..." },
  {
    "role": "assistant",
    "toolCalls": [
      {
        "id": "call_A",
        "name": "commit_turn_plan",
        "arguments": {}
      }
    ]
  },
  {
    "role": "tool",
    "toolCallId": "call_A",
    "name": "commit_turn_plan",
    "content": {}
  }
]
```

这样 Langfuse 才能按消息角色展示上下文，而不是把所有内容折叠成一块 JSON。

### 2. 新增 `AgentLoopTelemetryBridge`

桥接器维护：

```ts
Map<toolCallId, ActiveToolObservation>
```

事件处理规则：

| Agent Event | 遥测行为 |
| --- | --- |
| `turn_start` | 开始一次带阶段语义的 Generation |
| assistant `message_end` | 记录文本或规范化 Tool Calls |
| `tool_execution_start` | 创建 Tool Observation，保存 ID、名称和脱敏参数 |
| `tool_execution_end` | 用相同 ID 写入模型可见 Tool Result、错误和耗时，然后结束 Tool |
| `turn_end` | 完成 Generation usage、cost、stop reason，并验证 Tool Result 闭环 |

Agent 结束时若 Map 中仍存在未关闭 Tool，必须以 `TOOL_OBSERVATION_INCOMPLETE` 结束并产生诊断计数，不能静默丢失。

### 3. 将 `toolCallId` 贯穿执行上下文

Tool Protocol 不再忽略 ID，而是向 Host 传递调用上下文：

```ts
type AgentToolExecutionContext = {
  toolCallId: string;
  toolName: string;
  inferenceIndex: number;
  phase: "PLAN" | "FINALIZE" | "REPAIR";
};
```

Host、Provider 和持久化 Span 继承该上下文。Provider 调用成为模型 Tool 的子节点，而不是平铺的同级节点。

### 4. 区分模型可见结果与内部执行摘要

每个 Tool Observation 分别记录：

```ts
type ObservedToolResult = {
  modelVisibleResult: unknown;
  internalExecutionSummary: {
    status: string;
    stateRevisionBefore?: number;
    stateRevisionAfter?: number;
    claimCount?: number;
    evidenceKeyCount?: number;
    artifactRefs?: string[];
  };
};
```

- `modelVisibleResult`：实际返回给模型的脱敏内容，用于解释下一次 Generation。
- `internalExecutionSummary`：Host、数据库、ResearchWave 与 Evidence 的执行结果。

不允许用内部摘要代替模型实际看到的 Tool Result。

### 5. 使用阶段语义命名 Generation

- `planner.plan`
- `planner.finalize`
- `planner.repair`

同时记录：

```json
{
  "phase": "FINALIZE",
  "inferenceIndex": 2,
  "trigger": "TOOL_RESULT",
  "precedingToolCallIds": ["call_A"],
  "remainingInferenceBudget": 0
}
```

发生协议修复时，Trace 应明确展示：

```text
planner.plan
commit_turn_plan → rejected
planner.repair
commit_turn_plan → accepted
planner.finalize
```

### 6. 重构 Tool 层级

顶层 Tool 表示模型调用；子 Span 表示确定性系统如何执行：

```text
commit_turn_plan
├─ validate-plan
├─ stage-plan
├─ execute-operation: inspect-search-coverage
│  └─ load-research-wave
├─ execute-operation: research
│  └─ search-provider
└─ build-model-visible-result
```

Guardrail 放在其实际保护的阶段下，而不是统一平铺在 Trace 根节点。

### 7. 建立 Experiment 与业务 Trace 双向关联

Experiment wrapper 和所有业务 Turn Trace 都记录：

- `datasetRunId`
- `datasetItemId`
- `experimentWrapperTraceId`
- `trialId`
- `taskId`
- `runIndex`
- `turnIndex`
- `attempt`

一个 Dataset Item 可以关联多条 Turn Trace，不强行把整项实验塞进一个超大 Trace。

### 8. 调整 Turn 与 attempt 的身份模型

建议拆分：

```text
turnGroupId       同一个用户 Turn 的稳定关联 ID
traceId           每次 attempt 独立
attempt           当前尝试序号
supersedesTraceId 上一次 attempt Trace
```

创建真实 `conversation-turn` 根 Span，或使用标准 Span Link；不再构造一个没有对应 Observation 的 parent span。

## 隐私与成本边界

### 默认始终允许采集

- 消息角色和顺序
- Tool 名称、ID、Schema 哈希
- 状态版本和结构化 diff 类型
- claim/evidence 数量及不可逆引用哈希
- ResearchWave ID、覆盖摘要和 Artifact Ref
- 错误分类、阶段、恢复状态

### 仅在显式授权环境采集

- 脱敏后的用户原文
- 脱敏后的模型输出
- 脱敏后的 Tool 参数和模型可见结果

### 永不采集

- API Key、Cookie、Authorization、密码
- 未脱敏 Provider 原始响应
- 模型隐藏思维链
- 无保留策略的完整用户画像

长 Context 采用“结构化摘要 + 内容哈希 + 可控 Artifact 引用”，避免将大对象全部复制进每个 Generation。

## 验收标准

### 因果完整性

- 每个 assistant Tool Call 都存在非空 `toolCallId`。
- 每个 `tool_execution_start` 都有唯一匹配的 `tool_execution_end`，异常终止除外且必须显式标记。
- 每个 Tool Result 的 `toolCallId` 与前一条 Tool Call 一致。
- 下一次 Generation Input 能找到前序 Tool Call 和 Tool Result。
- 不存在无法归属到模型 Tool 的顶层 Host Tool。

### 上下文真实性

- Generation Input 来自最终 Provider 调用边界，而不是 Worker 预估摘要。
- 每次 Generation 记录 `contextSha256` 和 `toolSchemaSha256`。
- 第二次及后续 Generation 的输入包含前序模型可见 Tool Result。
- Prompt、模型、参数、实现、状态和 Provider Artifact 具备可复现引用。

### 展示可读性

- Generation 使用 `plan/finalize/repair` 阶段名。
- Langfuse 使用标准 Chat Message 形式展示上下文。
- 模型 Tool、Host 执行、Provider 和 Guardrail 形成清晰层级。
- 失败 Score 可从 Experiment wrapper 定位到具体 Turn、attempt、Generation 和 Tool。
- 不存在合成父节点导致的 orphan Observation。

### 安全性

- 内容采集仍受双重授权控制。
- `toolCallId`、业务 ID 和 Artifact Ref 经过格式及长度约束。
- 现有敏感字段、密钥、邮箱和支付信息脱敏测试继续通过。
- 新增上下文与 Tool Result 的隐私回归测试。

### 漂移控制

- 改造只改变遥测表达，不改变 Agent 决策、Host 授权、状态提交和回复结果。
- 同一冻结用例在改造前后的业务产物语义一致。
- Trace 完整性门槛通过后，再执行下一轮 39×3，避免用新运行掩盖观测缺陷。

## 实施阶段

### Phase 1：恢复 Tool 因果链

- 处理 `tool_execution_start/end`。
- 保存并传播 `toolCallId`。
- 采集 `modelVisibleResult`。
- 为 Generation 增加阶段语义。

### Phase 2：采集真实模型上下文

- 在 `streamFn` 边界增加模型调用遥测包装器。
- 输出标准 Chat Message。
- 增加 Context、Tool Schema 和状态摘要哈希。

### Phase 3：重构 Trace 层级

- 模型 Tool 作为顶层业务调用。
- Host、Provider、数据库和 Guardrail 成为子节点。
- 建立 attempt 与 supersede 关系，移除合成父节点。

### Phase 4：打通 Experiment 归因

- wrapper 与 Turn Trace 写入双向关联字段。
- Score 增加失败阶段、责任层和恢复状态。
- 增加 Langfuse 服务端结构验收器。

## 不采用的方案

### 继续给现有 Span 增加 metadata

不能解决因果关系和层级问题，只会产生更大的 JSON。

### 将完整会话、状态和 Provider 响应全部上传

增加隐私、成本和信息噪音，也不利于快速定位。应优先采集模型真实可见内容和结构化状态变化。

### 把整个 Experiment Item 塞进一条超大 Trace

一个 Item 可能包含多轮 Turn 和多次 attempt。强行合并会破坏生产 Trace 边界，应通过标准关联字段和 Trace Link 组织。

### 采集模型隐藏思维链

Agent 诊断需要的是输入、工具选择、工具结果、状态变化和最终输出，不需要也不应依赖隐藏思维链。

## 面试表达参考

### 一分钟版本

项目最初已经接入 Langfuse，能够看到模型、工具和 Guardrail，但我在真实评测中发现 Trace 只是把节点平铺出来，无法回答 Tool Result 是否真正进入下一轮推理。进一步检查后发现，Agent SDK 已经提供 `tool_execution_start/end` 和 `toolCallId`，但遥测桥接层忽略了这些事件，Tool Protocol 也主动丢弃了调用 ID；同时 Generation 记录的是 Worker 构造的摘要，而不是 Provider 边界的真实 Context。

我把问题从“补日志字段”重新定义成“重建 Agent Loop 因果图”：在模型边界采集标准消息上下文，以 `toolCallId` 关联 Tool Call 与 Tool Result，将 Host、Provider 和 Guardrail 作为模型 Tool 的子节点，并用 `plan/finalize/repair` 区分推理阶段。这样一条失败 Score 可以下钻到具体 Generation、Tool Result 和状态变化，同时保留脱敏与内容授权边界。

### 深挖时的关键观点

1. Agent 可观测性不是普通调用链监控，核心是观察“上下文—决策—行动—结果—下一次决策”的闭环。
2. Prompt 版本一致不代表模型输入一致，真正的可复现边界在 Provider 调用前的最终 Context。
3. `toolCallId` 是 Agent Loop 的因果主键，不能只记录 Tool 名称和耗时。
4. Tool Result 应区分模型可见结果和内部执行摘要，否则无法解释下一次模型行为。
5. 可读性问题通常不能通过增加 metadata 解决，需要调整 Trace 身份、层级和消息表达。
6. 内容安全与可诊断性并不冲突：默认采集结构化语义和哈希，授权后才采集脱敏正文。

## 实施结果与验收证据（2026-08-29）

Issue 已按“重建 Agent 因果图”而不是“继续堆 metadata”的目标完成：

- 在最终 Provider 调用边界采集真实消息上下文、Tool Schema、模型参数及其哈希；Generation 按 `plan / finalize / repair-plan / repair-finalize` 命名。
- `ConversationToolProtocol` 不再丢弃 `toolCallId`；模型 Tool Call、模型可见 Tool Result、下一次 Generation Context 由同一 ID 串联，并由独立 Guardrail 校验配对完整性。
- Trace 形成 `conversation-turn CHAIN → execute-turn-attempt AGENT → Generation / agent.tool.* TOOL → Host SPAN → Provider TOOL` 的可读层级；Host 内部步骤不再伪装成模型 Tool。
- API 入队创建真实 `conversation-turn` 根 Observation，并把 trace/root observation ID 持久化到 Turn；Worker 跨异步边界继续使用同一棵树。遥测关闭或导出失败时不影响业务提交。
- Experiment wrapper 与每条业务 Turn Trace 通过 Dataset Run、Dataset Item、trial、task、run、turn 等字段双向关联；原生 Prompt 版本绑定在 Generation，资格评分使用 Scores v3 回读。
- 内容默认仍不采集；只有 `CAPTURE_CONTENT=true` 且提供显式 consent 才记录经脱敏的正文，隐藏思维链始终不采集。

真实服务验收执行 `gbv1-compare_existing-01`，由 `deepseek-v4-flash` 完成 1 个两轮 Trial：

- Dataset Run：`54f9e861-67f3-4f0b-8303-a3047f2ef8e1`，1/1 item 完成。
- 两条业务 Trace：`92b1fda9b736d5db442759a4c99f6ec0`、`d64642961813390d5c59d9c02b4aaa75`。
- 每条 Trace 均存在 1 个 CHAIN 根、1 个 AGENT、2 个 Generation、2 个 `agent.tool.*`，Prompt/usage/context manifest/tool causality/Experiment correlation 全部通过服务端回读。
- Scores v3 回读 5 个布尔评分，业务通过、协议整洁、预期结果、状态一致、Trace 完整均为 1。该结果仅是内部验收证据，仍保持 `eligibleForResumeMetrics=false`。

漂移检测结果：Gold Blueprint 仍为 39 个任务，语义哈希保持 `sha256:a4bc8ac0a4c98d6e12800afd46328e303d81461058942b680b8de9b08d2aaeca`；协议对抗 30/30、单测 241/241、PostgreSQL 集成 24/24。改造没有改变 Agent 决策、Host 授权或业务评测口径。

验收过程中还发现 Langfuse Observations v2 的 I/O 属于独立 `io` 字段组，且以序列化 JSON 返回。服务端验收器已显式请求并解析该字段，避免把“检查器未请求数据”误判成“摄取丢失”。

## 预期收益

- 从失败 Score 直接定位到具体模型上下文和 Tool 因果节点。
- 区分模型决策错误、Tool 参数错误、Host 拦截、Provider 异常和状态提交问题。
- 识别协议修复与正常双阶段推理，避免把 Host 恢复误判为业务失败。
- 在不暴露敏感信息的前提下具备推理输入复现能力。
- Trace 从“事件堆积”升级为可阅读、可归因、可复现的 Agent 执行图。
