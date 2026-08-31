# 受策略约束的 Pi-Agent 规划：实施方案

## 1. 目标与完成定义

本方案将当前“Pi-Agent 提案 + 宿主静默改写/兜底”的实现替换为“Pi-Agent 提案 + 显式策略审批 + 有界修复 + 单一路径执行”。完成不以新增类或测试通过为准，而以以下用户行为同时成立为准：

1. 复合自然语言请求仍由 Pi-Agent 形成有序计划；
2. 非法计划得到结构化修复反馈，而不是被宿主静默改成另一个意图；
3. 模型或协议失败不会伪装成用户信息不足；
4. 问题含义明确但证据未知时，系统披露未知而不是追问用户；
5. 互补品、配件和身份未决商品不会进入主商品正式推荐；
6. 排序、解释和回复只能消费已经准入且有证据的候选；
7. 新路径切换后删除旧的语义改写和通用 rephrase fallback。

## 2. 当前架构审计

| 当前组件 | 保留 | 需要替换 |
|---|---|---|
| `turn-agent.ts` | Pi-Agent、受限工具、分阶段协议 | 错误恢复只返回低信息错误，Prompt 存在历史协议字段 |
| `protocol.ts` | `commit_turn_plan → execute → publish_reply` 骨架 | commit 失败缺少正式 `PlanReview` 修复协议 |
| `plan-normalizer.ts` | 纯机械归一化能力 | 明确禁止承担语义恢复；复核当前派生是否改变用户意图 |
| `conversation-policy.ts` | provider 必要性、状态前置条件 | 删除静默增加搜索、替换澄清、删除操作等语义改写 |
| `clarification-decision-policy.ts` | “是否值得问”的业务思想 | 从计划改写器改为审批器，只返回批准或违规原因 |
| `conversation-turn-executor.ts` | 引用绑定、执行、receipts、证据发布 | 删除无计划时生成 `TURN_REPHRASE` 的语义 fallback 和不可达恢复分支 |
| `product-identity.ts` | 来源化商品身份与 item role | 不再用标题 token 命中代替查询—商品相关性 |
| `kernel.ts` | 三态/四态 eligibility、预算市场证据校验 | 在排序前接入 ESCI 相关性和 cohort 准入 |
| `assistant-envelope.ts` 与 claim validator | 回复结构和来源校验 | 增加回答完整性/未知事实模式校验 |

## 3. 目标契约

### 3.1 PlanReview

新增领域类型，但不新增通用 DSL：

```ts
type PlanReviewDecision = "APPROVED" | "REPAIR_REQUIRED" | "REJECTED";

interface PlanPolicyViolation {
  code: string;
  operationId: string | null;
  path: string;
  observed: unknown;
  admissibleAlternatives: Array<{
    operationKind: TurnOperation["kind"];
    constraints: Record<string, unknown>;
  }>;
}

interface PlanReview {
  decision: PlanReviewDecision;
  policyVersion: string;
  violations: PlanPolicyViolation[];
  approvedPlan: TurnPlan | null;
}
```

策略模块返回 `PlanPolicyViolation[]`，组合器按照严重性形成唯一审批结果。策略不得返回用户文案，也不得直接调用 provider 或修改 ConversationState。

### 3.2 提案状态机

```text
CONTEXT_READY
  → PLAN_PROPOSED
  → PLAN_REVIEWED
      → APPROVED → EXECUTING
      → REPAIR_REQUIRED → CONTEXT_READY (bounded)
      → REJECTED → DEGRADED
  → ANSWER_REQUIRED
  → ANSWER_REVIEWED
  → COMPLETED
```

只有 `APPROVED` 计划可以写入最终 `plan_json` 并执行。所有未批准提案只能写入审批审计记录。

### 3.3 策略组合

```ts
interface TurnPlanPolicy {
  readonly id: string;
  readonly version: string;
  review(input: TurnPlanPolicyInput): PlanPolicyViolation[];
}
```

首批策略：

- `OperationCompositionPolicy`
- `GoalReadinessPolicy`
- `ProviderUsePolicy`
- `ClarificationPolicy`
- `ReferentPreconditionPolicy`
- `StateTransitionPolicy`

这些名称对应稳定职责，不对应具体句式或商品类目。

### 3.4 候选相关性

```ts
interface QueryProductRelevanceAssessment {
  label: "EXACT" | "SUBSTITUTE" | "COMPLEMENT" | "IRRELEVANT" | "UNRESOLVED";
  confidence: number | null;
  assessor: "PROVIDER_TAXONOMY" | "CATALOG_MAPPING" | "SEMANTIC_MODEL" | "CONFLICT_RESOLUTION";
  evidenceRefs: EvidenceRef[];
  policyVersion: string;
}
```

不为特定商品增加生产分支。商品名称只允许出现在评估样本中。

准入映射第一版固定为：

| ESCI | 主商品推荐 | 处理方式 |
|---|---:|---|
| EXACT | 是 | `COMPARABLE` |
| SUBSTITUTE | 否 | 独立 alternative cohort；首版不进入正式推荐 |
| COMPLEMENT | 否 | 关联商品 cohort；不参与主商品排名 |
| IRRELEVANT | 否 | `INELIGIBLE` |
| UNRESOLVED | 否 | `INSUFFICIENT_EVIDENCE` |

### 3.5 Answerability

回答策略不读取原始文案，而根据批准操作及 receipts 判断：

```ts
type AnswerabilityDecision =
  | { mode: "ANSWER"; claimIds: string[] }
  | { mode: "DISCLOSE_UNKNOWN"; factKinds: ClaimKind[] }
  | { mode: "RETRIEVE"; capability: string }
  | { mode: "CLARIFY"; clarification: ClarificationIntent }
  | { mode: "DEGRADE"; failureOwner: "SYSTEM"; errorCode: string };
```

`CLARIFY` 必须能证明存在 `INTENT_AMBIGUITY` 或 `MISSING_USER_INFORMATION`。库存、保修等事实未知属于 `MISSING_EVIDENCE`。

## 4. 替换式迁移顺序

### P0：锁定路线与刻画现状

交付：

- ADR-0005、目标契约和本实施计划；
- 把最新真实会话固化为行为级回归轨迹；
- 记录当前计划静默改写、错误归因、候选污染和内部代码外露的基线指标。

门禁：

- 架构目标检查通过；
- 不修改生产行为；
- bad case 仅作为回归样本，不产生专用生产规则。

### P1：引入显式 PlanReview 与有界修复

交付：

- 领域 `PlanReview`/`PlanPolicyViolation`；
- 可组合策略审批器；
- `commit_turn_plan` 返回结构化 `APPROVED` 或 `REPAIR_REQUIRED`；
- 默认一次修复的 proposal budget；
- 持久化每次提案、审批和最终计划。

迁移方式：

1. 先以 shadow review 读取同一提案，不改变生产状态；
2. 比较旧策略结果与新审批结果；
3. 达到门禁后切换 commit 权限；
4. 切换后不保留旧审批开关。

门禁：

- Pi-Agent 对复合话轮的计划覆盖率不下降；
- 非法计划没有执行副作用；
- repair trace 包含 location、observed value 和 admissible alternatives；
- shadow review 不双写 Goal/Dialogue/WorkingSet。

### P2：在排序前引入 ESCI 候选准入

交付：

- `QueryProductRelevanceAssessment`；
- provider taxonomy/catalog mapping/semantic model 的证据优先级；
- ESCI 到 eligibility/cohort 的确定性映射；
- qualification 记录保存相关性、策略版本和证据；
- ranking 只接收正式准入 cohort。

门禁：

- `COMPLEMENT`、`IRRELEVANT`、`UNRESOLVED` 不进入主商品推荐；
- `SUBSTITUTE` 不与 `EXACT` 混排；
- 冲突证据 fail closed；
- 使用跨类目 ESCI 数据集评估，而不是只验证耳机样本。

### P3：引入不确定性归属与 Answerability

交付：

- `INTENT_AMBIGUITY / MISSING_USER_INFORMATION / MISSING_EVIDENCE / SYSTEM_FAILURE`；
- Clarification policy 从计划改写器变为审批器；
- Answerability decision 消费已批准操作和 receipts；
- 缺失事实以自然语言披露，内部 disclosure/reason code 不直接展示。

门禁：

- 每次澄清都有可审计的用户可解决信息缺口；
- `MISSING_EVIDENCE` 不触发用户改写；
- `SYSTEM_FAILURE` 不触发澄清；
- “问题明确但事实未知”轨迹稳定返回 `DISCLOSE_UNKNOWN`。

### P4：删除静默语义改写与旧 fallback

删除或改写：

- `ConversationPolicy` 中增加搜索、替换澄清、删除语义操作的分支；
- `fallbackReply` 中无计划时构造 `REQUEST_CLARIFICATION(TURN_REPHRASE)` 的分支；
- 任何从原始文案恢复通用意图的 executor 关键词解析；
- Prompt 中历史 `questionSlotId` 等旧协议描述；
- 把 offerRef、模型文本或异常 message 当作稳定 failure code 的逻辑；
- 面向用户直接渲染内部 reason/disclosure code 的路径。

保留：

- 结构化 UI 操作的直接执行；
- 纯机械 canonicalization；
- 有批准计划和安全 receipts 时的证据化降级发布；
- 旧持久化数据的读取边界迁移，不保留旧执行引擎。

门禁：

- 生产只有一个 plan commit 路径；
- 无不可达恢复代码；
- 无 generic rephrase 作为模型失败出口；
- 架构静态检查能够阻止旧模式重新出现。

### P5：全链路验收与切换

必须覆盖：

- 模型提案被批准并执行；
- 模型首次提案被拒、根据结构化反馈修复并成功；
- 修复耗尽后系统降级且不污染状态；
- ESCI 各标签的候选准入；
- 已知事实、未知事实、意图歧义和系统失败四类回答；
- 两市场完整检索但某市场无合格候选时的覆盖说明；
- 模型、Buywhere、PostgreSQL、API 和前端真实多轮链路。

切换策略：只允许 shadow observation，不允许双写；发布切换后通过部署上一构建回滚。

## 5. 数据与持久化建议

新增 `turn_plan_reviews` 审计表：

- `turn_id`
- `attempt`
- `proposal_no`
- `proposal_json`
- `decision`
- `violations_json`
- `policy_version`
- `created_at`

最终 `turn_attempts.plan_json` 仍只保存批准计划，避免“提案”和“已承诺执行计划”语义混淆。

候选相关性可扩展当前 qualification 记录，至少持久化：

- `relevance_label`
- `relevance_confidence`
- `relevance_assessor`
- `relevance_evidence_refs`
- `admission_policy_version`

## 6. 测试与评估

### 不变量测试

- 未批准计划永不执行；
- policy review 永不修改输入提案；
- 模型失败永不生成澄清；
- 澄清必须引用用户可解决的信息缺口；
- `MISSING_EVIDENCE` 永不渲染为肯定事实；
- 非 `EXACT` 候选永不进入主商品正式推荐；
- 排序不改变候选 cohort；
- 回复中的每个事实都能回溯到 claim 和 evidence。

### 属性测试

- 对操作顺序、重复操作、冲突 Goal 修改和状态版本进行生成式测试；
- 对同一语义的多语言改写只评价结构化结果，不驱动生产关键词规则；
- 对跨类目 ESCI 样本验证关系分类和准入映射。

### 指标

- `plan_review_total{decision, violation_code}`
- `plan_repair_success_rate`
- `unapproved_plan_execution_total`（必须为 0）
- `clarification_total{uncertainty_source}`
- `system_failure_as_clarification_total`（必须为 0）
- `candidate_admission_total{esci_label, decision}`
- `non_exact_main_recommendation_total`（必须为 0）
- `unknown_fact_assertion_total`（必须为 0）
- `market_coverage_disclosure_rate`

## 7. 目标漂移检查

每一阶段结束必须回答：

1. Pi-Agent 是否仍在规划每个自然语言话轮？
2. 策略是否只审批，而没有演化成第二个 planner？
3. 是否新增了针对具体句式、商品名或单一类目的生产分支？
4. 是否存在两个可写生产状态的执行路径？
5. 模型、证据或系统不确定性是否仍可能被包装成用户问题？
6. 排序是否可能绕过候选准入？
7. 新增抽象是否是领域共识概念，还是新的项目内黑话？

任一答案不满足，阶段不得封板。

## 8. 研究来源

- [ConvLab-2](https://aclanthology.org/2020.acl-demos.19/)
- [CR-Walker](https://aclanthology.org/2021.emnlp-main.139/)
- [HutCRS](https://aclanthology.org/2023.emnlp-main.635/)
- [Clarify When Necessary](https://aclanthology.org/2025.findings-naacl.306/)
- [Selectively Answering Ambiguous Questions](https://aclanthology.org/2023.emnlp-main.35/)
- [Robots That Ask For Help / KnowNo](https://arxiv.org/abs/2307.01928)
- [Structured Feedback Improves Repair in an LLM Agent Loop](https://arxiv.org/abs/2607.14167)
- [AgentSpec](https://arxiv.org/abs/2503.18666)
- [OpenAI Agents SDK Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- [Amazon Shopping Queries Dataset / ESCI](https://arxiv.org/abs/2206.06588)

