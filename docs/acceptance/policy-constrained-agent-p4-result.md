# P4 验收：删除宿主语义接管与旧兜底

日期：2026-08-30  
阶段：`P4_DELETE_OLD_SEMANTIC_FALLBACKS`

## 结论

P4 通过。自然语言话轮的业务语义现在只有一位提议者：Pi-Agent。ConversationPolicy 与 ClarificationPolicy 只对原计划作批准或结构化拒绝，不再增加、删除、替换操作；TurnExecutor 不再从原始文本关键词补出目标、市场、预算、刷新、偏好或候选反馈操作；无批准计划的失败只发布系统拥有的降级结果。

这次修改不是把旧代码设为不可达，而是物理删除旧的语义恢复分支，并用静态门禁禁止回流。

## 交付证据

### 1. ConversationPolicy 收缩为纯审批器

- `evaluateConversationPolicy` 先校验并投影原始 `TurnPlan`，返回的 `plan` 与 Agent 提案语义一致；
- 缺少目标、市场、必要搜索或存在冗余 provider search 时，返回稳定 `DomainError`，由 `PlanReview` 转为 `REPAIR_REQUIRED`；
- 不再生成 `executor-required-*` 操作，不再删除澄清或搜索，不再把一种澄清改为另一种澄清；
- `PlanReview` 给出 violation path、observed operation kinds 和 admissible alternatives，修复仍由 Pi-Agent 提交。

### 2. 探索性假设也由 Agent 显式规划

- 用户明确跳过购买市场问题后，Agent 可提出受限 `marketScope: ["US", "SG"]`；
- 该计划必须同时携带 `PURCHASE_MARKET_SCOPE_ASSUMED`，否则审批拒绝；
- schema 只允许 US/SG 和两个注册 assumption disclosure code；
- domain plan boundary 再次校验范围、披露码及二者一致性；
- 策略仅验证同轮或历史中确有 `PURCHASE_MARKET -> SKIPPED`，不替 Agent 生成范围或披露。

### 3. TurnExecutor 不再是第二个自然语言 planner

已物理删除：

- `allowLexicalIntentRecovery` 及目标、市场、预算、刷新、低价偏好的关键词补操作逻辑；
- `recoverExplicitWorkingSetProposal` 的候选排除补操作逻辑；
- `inspectionFieldsFromMessages` 的文本字段推断兜底；
- 无计划 fallback 中生成 clarification、UI focus、inspection 或 `TURN_REPHRASE` 的旧恢复分支。

保留的是模型提案值的来源校验、类型规范化、序号指代约束、证据校验和已批准计划执行；这些不会创造新的用户意图。

### 4. 单一提交和失败所有权

- `onPlanCommitted` 只有一条调用路径，且位于 `APPROVED` 之后；
- `fallbackReply` 只有一个无计划分支；
- 无计划失败使用空业务操作计划，仅形成 `SYSTEM_FAILURE -> DEGRADED`；
- 不创建 pending clarification，不要求用户重述，不修改 WorkingSet/UI focus；
- 有批准计划和 receipts 时仍允许证据安全的 fallback publication。

### 5. 旧模型协议引用清理

- prompt 不再引用 `questionSlotId`；问题只能使用 receipts 返回的 `questionClarifications`；
- prompt 不再教授活跃模型处理历史 `TURN_REPHRASE`；该值只在历史持久化读取边界做迁移兼容；
- `scripts/check_policy_constrained_agent_p4.mjs` 固化纯审批、无 executor 关键词 planner、单提交、无计划系统降级、受限探索假设与旧 prompt 字段删除。

## 否定式验收

| 被否定的设计 | 验收结果 |
|---|---|
| 策略发现计划不完整后自动补 `SEARCH_OFFERS` | 拒绝；返回 `SEARCH_OPERATION_REQUIRED` |
| 策略把可选澄清删除并直接搜索 | 拒绝；策略保持原计划，完整 reviewer 要求 Agent 修复 |
| 策略把缺市场的搜索改成购买市场问题 | 拒绝；返回 `SEARCH_MARKETS_REQUIRED` |
| 策略为缩小市场范围删除冗余搜索 | 拒绝；返回 `UNNECESSARY_PROVIDER_SEARCH` |
| 执行器从原始句子补目标、预算、市场、刷新、排序偏好 | 代码已删除，P4 静态门禁禁止恢复 |
| 模型失败后创建 `TURN_REPHRASE` | 代码已删除；结果为系统降级 |
| 用户跳过市场后宿主静默选择默认范围 | 拒绝；Agent 必须显式提交范围与披露，策略只审批 |

## 验证结果

- `npm run typecheck`：通过；
- `npm run test:unit`：42 files，277 tests 全部通过；
- `npm test`：42 files / 277 tests 通过，2 files / 25 PostgreSQL tests 按普通配置跳过；
- `npm run test:integration`：2 files，25 tests 全部通过；
- `npm run build`：domain、agent、runtime、API、frontend 全部通过；
- `npm run architecture:p4:check`：通过；
- P0、P1、P2、P3、active architecture、workflow、observability 静态门禁：全部通过。

## 目标漂移检查

1. Pi-Agent 是否仍为自然语言话轮唯一业务计划提议者：是；P4 删除了两个宿主提议源。
2. 策略是否只审批：是；所有缺失或冲突操作均形成稳定 violation，策略不改写计划。
3. 是否用新规则堆叠替代旧 badcase：否；新增检查只约束操作类型、状态前置条件、授权范围与披露一致性，不匹配具体商品或句式。
4. 是否削弱 provider 安全边界：否；provider 调用仍最多一次，目标/市场/goal gaps/覆盖充分性仍在执行前审批。
5. 是否削弱用户跳过问题后的可用性：否；探索性 search-then-refine 仍可用，但由 Agent 显式计划且需披露。
6. 是否破坏 P2 ESCI 或 P3 Answerability：否；候选准入、receipt-based answerability 和系统失败归属未改变，P2/P3 门禁均通过。
7. 是否删除了必要的确定性能力：否；结构化 UI 命令、模型提案值校验、referent binding、证据校验与安全 publication 均保留。
8. 是否仍有第二条计划提交路径：否；静态门禁要求恰好一个 `onPlanCommitted` 调用点。

## P5 边界

P4 只完成代码路径收敛和离线/集成验收，不把外部系统可用性冒充为完成。下一阶段必须使用真实模型、Buywhere、PostgreSQL、API 与前端执行现场验收，重点验证结构化 repair 是否在真实模型下收敛、跳过市场后的显式探索计划、缺证据披露、无计划系统降级，以及用户最初反馈的“关键选购条件缺少方向”体验。
