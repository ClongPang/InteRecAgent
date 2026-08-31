# ADR-0005：采用受业务策略约束的 Pi-Agent 规划

- 状态：Accepted for implementation
- 日期：2026-08-30
- 细化：ADR-0004 中“Agent 规划、执行器约束”的职责边界
- 不替代：ADR-0003 的来源充分性与证据准入原则

## 背景

当前运行时已经让 Pi-Agent 为每个自然语言话轮提交有序 `TurnPlan`，并由宿主执行器完成状态变更、工具调用、证据校验和原子发布。这个骨架是正确的，但当前实现仍有三个职责混叠：

1. `ConversationPolicy` 会静默删除、替换或补充模型计划中的语义操作；
2. `fallbackReply` 会在模型协议失败后替用户生成新的澄清计划；
3. 商品身份、候选准入和排序之间缺少标准化的查询—商品相关性判断。

这些问题使系统把协议失败误归因于用户表达，把来源可信误当作推荐相关，并诱发围绕单个 bad case 增加 Prompt、正则和条件分支。

## 决策

采用 **policy-constrained agent planning（受策略约束的 Agent 规划）**：

```text
Conversation state + user messages
              ↓
Pi-Agent proposes TurnPlan
              ↓
Plan policy review
   ├─ APPROVED ───────────────→ commit and execute
   ├─ REPAIR_REQUIRED ────────→ Pi-Agent repairs within a bounded budget
   └─ REJECTED ───────────────→ system-owned degraded outcome
              ↓
Operation receipts + evidence
              ↓
Pi-Agent proposes AssistantEnvelope
              ↓
Claim/output validation
              ↓
Atomic publication
```

Pi-Agent 保留自然语言理解、复合任务分解、工具选择、操作排序、有限修复和回复组织权。业务策略只判断计划是否满足业务不变量，不替 Agent 生成完整自然语言话轮计划。

结构化 UI 输入（例如选择澄清选项、设置比较集合）已经表达为权威类型，不属于自然语言规划，可继续走宿主直接计划路径。

## 计划审批协议

计划审批必须返回类型化结果：

```ts
type PlanReview =
  | { decision: "APPROVED"; policyVersion: string }
  | {
      decision: "REPAIR_REQUIRED";
      policyVersion: string;
      violations: PolicyViolation[];
    }
  | {
      decision: "REJECTED";
      policyVersion: string;
      failureOwner: "SYSTEM";
      violations: PolicyViolation[];
    };

interface PolicyViolation {
  code: string;
  operationId: string | null;
  path: string;
  observed: unknown;
  admissibleAlternatives: string[];
}
```

`REPAIR_REQUIRED` 必须告诉 Agent 失败位置、观察值和允许的替代行为。审批不得通过自然语言异常消息隐式引导模型，也不得静默改写语义操作。

允许宿主执行的规范化仅限：

- 协议别名归一化；
- 用户消息序号绑定为持久化消息 ID；
- 稳定 ID、去重和执行所需的机械派生；
- 不改变用户意图的 canonical value 归一化。

增加搜索、改变澄清类型、删除用户请求或把失败转换为澄清都属于语义决策，必须由 Pi-Agent 修复后重新提交，不能由 normalizer 静默完成。

## 业务策略的组成

不建立单体 `BusinessPolicy`，而按业务边界组合策略：

- **Plan policy**：操作组合、状态前置条件、资源预算和 provider 必要性；
- **Clarification policy**：澄清是否对应可由用户解决且影响决策的信息缺口；
- **Candidate admission policy**：检索结果是否可进入正式推荐、替代候选或关联商品区域；
- **Answerability policy**：已执行操作和证据是否支持回答、披露未知、补充检索或降级；
- **Claim policy**：用户可见事实是否具有足够来源和一致的 canonical value。

策略读取结构化计划、状态、能力和证据，不解析原始用户文案。模型可以提供开放世界语义判断，但不能直接决定硬准入结果。

## 不确定性归属

系统必须区分：

- `INTENT_AMBIGUITY`：存在多个会改变执行结果的用户意图解释；
- `MISSING_USER_INFORMATION`：缺少由用户掌握且影响决策的信息；
- `MISSING_EVIDENCE`：问题明确，但当前事实未知或证据不足；
- `SYSTEM_FAILURE`：模型、协议、工具或运行时失败。

只有前两类可以进入澄清审批。`MISSING_EVIDENCE` 应披露未知或补充证据，`SYSTEM_FAILURE` 应重试或发布系统拥有的降级结果。模型协议失败不得映射为 `REQUEST_CLARIFICATION(TURN_REPHRASE)`。

## 查询—商品相关性与候选准入

采用商品搜索领域的 ESCI 相关性语义：

- `EXACT`
- `SUBSTITUTE`
- `COMPLEMENT`
- `IRRELEVANT`
- `UNRESOLVED`（项目为无法可靠分类增加的保守状态）

相关性判断可以依次使用 provider 结构化商品类型、类目映射、商品身份信息和受约束语义模型。最终准入由确定性策略完成：

- `EXACT` 可进入正式推荐；
- `SUBSTITUTE` 只能进入明确披露差异的替代候选路径；
- `COMPLEMENT` 不得进入主商品推荐，可保留为关联商品；
- `IRRELEVANT` 必须排除；
- `UNRESOLVED` 为证据不足，不得冒充正式推荐。

排序只能作用于已经完成准入的同一候选集合，不能把互补品或身份未决商品重新提升为正式推荐。

## 失败与修复

- 自然语言计划默认允许一次有界修复；预算必须可配置并被追踪；
- 没有批准计划时，不得提交 Goal、DialogueState 或 WorkingSet 语义变更；
- 已有批准计划和安全 receipts、但回复生成失败时，宿主可以从 receipts 发布证据化降级回复；
- 没有批准计划且修复耗尽时，发布 `DEGRADED`，错误归属为系统；
- 失败原因必须是稳定错误码和结构化诊断，不能保存 offerRef 等偶然值作为错误码。

## 可观测性

每次计划提案和审批必须可关联到 turn、attempt、proposal number、policy version，并记录：

- 原始提案；
- 审批结果；
- 违规位置和允许替代行为；
- 修复是否成功；
- 最终批准计划；
- 候选 ESCI 判断、准入决定和依据；
- 不确定性归属与最终回答模式。

影子评估可以并行计算新策略结果，但不得双写 Conversation 状态。切换后只保留一个生产执行路径；回滚依赖上一可发布构建，不保留旧引擎运行时开关。

## 否决的替代方案

- **模型完全自治**：无法提供候选准入、证据和状态一致性的运行时保证；
- **宿主生成完整计划**：Pi-Agent 会退化为意图分类器，策略层演变为工作流引擎；
- **LLM Judge 单独审批**：错误相关、不可重复且增加延迟，只能作为离线评估信号；
- **通用策略 DSL**：当前边界用类型化 TypeScript 策略即可，暂不引入额外语言和解释器；
- **Prompt/正则 bad-case 修补**：不得用具体句式或商品名称驱动生产控制流；
- **静默语义改写**：让执行轨迹与 Agent 计划不一致，无法可靠诊断和修复。

## 研究依据

- ConvLab-2 的 NLU、状态、策略和生成分层；
- CR-Walker 使用 dialog acts 连接推荐推理与语言生成；
- OpenAI Agents SDK 的 input/output/tool guardrail 边界；
- AgentSpec 的运行时约束思路；
- VeriHarness 关于结构化验证反馈和可接受替代行为的修复实验；
- clarification/uncertainty 研究对意图歧义与事实未知的区分；
- Amazon Shopping Queries Dataset 的 ESCI 查询—商品相关性体系。

具体文献链接和迁移工作包见 `docs/policy-constrained-agent-implementation-plan.md`。

