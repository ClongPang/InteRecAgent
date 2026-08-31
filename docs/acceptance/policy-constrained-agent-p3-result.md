# P3 验收：不确定性归属与 Answerability

日期：2026-08-30  
阶段：`P3_UNCERTAINTY_AND_ANSWERABILITY`

## 结论

P3 通过。生产路径现在区分：

- `INTENT_AMBIGUITY`：只有多个用户含义或候选指代仍然合理时才允许澄清；
- `MISSING_USER_INFORMATION`：只有用户能够提供且会影响决策的信息才允许澄清；
- `MISSING_EVIDENCE`：补检索或以自然语言披露未知，不要求用户改写；
- `SYSTEM_FAILURE`：系统拥有的降级结果，不创建澄清计划或 pending clarification。

这不是新的业务 planner。Pi-Agent 仍提出有序 `TurnPlan`；ClarificationPolicy 只审批；Answerability 只读取批准计划和执行 receipts。

## 交付证据

### 1. 类型化不确定性

- `packages/domain/src/uncertainty.ts` 定义四类 `UncertaintyType`、`ClarificationUncertainty` 和 `AnswerabilityDecision`；
- `REQUEST_CLARIFICATION` 必须携带 `uncertainty.type` 与 `userResolvable: true`；
- 模型 schema 只允许 `INTENT_AMBIGUITY` 和 `MISSING_USER_INFORMATION`，不允许把 `MISSING_EVIDENCE`、`SYSTEM_FAILURE` 或通用 `TURN_REPHRASE` 提交为澄清。

### 2. ClarificationPolicy 是审批器

- `reviewClarificationRequest` 不增加、删除或改写操作；
- 通用 rephrase 返回 `GENERIC_REPHRASE_NOT_ACTIONABLE`；
- 不确定性和澄清种类不一致返回 `CLARIFICATION_UNCERTAINTY_MISMATCH`；
- 当前状态已经足够、用户已跳过或初始搜索不应被可选条件阻塞时返回 `CLARIFICATION_NOT_DECISION_RELEVANT`；
- 没有 WorkingSet 时不得询问候选指代。

### 3. 执行后 Answerability

- `evaluateAnswerability` 只消费批准计划和 `OperationReceipt`；
- 已知事实只能通过 receipt 中的 claim IDs 发布；
- `publicResult.unknownFields` 稳定形成 `DISCLOSE_UNKNOWN`；
- 模型/协议/工具失败形成 `DEGRADE`；
- 澄清 receipt 记录 `uncertaintyType`，计划内澄清与执行时确定的候选指代歧义都可在 trace 中审计；
- 非用户可解决的 blocked operation 形成系统降级。

### 4. 用户可见渲染

- PRICE、MERCHANT、MARKET、STOCK、MODEL、CONDITION、RANKING_REASON、WARRANTY 未知均有自然语言说明；
- 搜索覆盖、汇率、税费、结算页、商品身份和缓存说明均不直接展示内部 disclosure code；
- 未注册内部码使用安全通用文案，不回显机器码。

### 5. 观测与门禁

- `rec_agent.clarification.decisions{uncertainty_type,clarification_kind}`；
- `rec_agent.answerability.decisions{mode,uncertainty_type}`；
- `rec_agent.uncertainty.misattributions{source,rendered_as}`；
- `scripts/check_policy_constrained_agent_p3.mjs` 阻止四类不确定性、schema 边界、receipt-based Answerability、系统失败降级和自然语言披露发生漂移。

## 因果配对验收

| 场景 | 期望 | 结果 |
|---|---|---|
| 清晰的保修问题，来源没有保修字段 | `MISSING_EVIDENCE -> DISCLOSE_UNKNOWN` | 通过 |
| 相同保修问题，模型协议失败 | `SYSTEM_FAILURE -> DEGRADE` | 通过 |
| 合法缺少购买市场 | `MISSING_USER_INFORMATION -> CLARIFY` | 通过 |
| 候选指代有多个解析结果 | `INTENT_AMBIGUITY -> CLARIFY` | 通过 |
| 没有 WorkingSet 却执行候选操作 | `SYSTEM_FAILURE -> DEGRADE` | 通过 |
| 无批准计划的模型失败 | 空业务计划、无状态修改、无澄清、`DEGRADED` | 通过 |

## 验证结果

- `npm run typecheck`：通过；
- `npm run test:unit`：42 files，276 tests 通过；
- `npm test`：42 files / 276 tests 通过，2 files / 25 PostgreSQL tests 在普通运行中按配置跳过；
- `npm run test:integration`：2 files，25 tests 通过；
- `npm run build`：domain、agent、runtime、API、frontend 全部通过；
- `npm run architecture:p3:check`：通过；
- P0、P1、P2、active architecture、workflow、observability 静态门禁：全部通过。

## 目标漂移检查

1. Pi-Agent 是否仍规划每个自然语言话轮：是；P3 没有新增宿主自然语言 planner。
2. 策略是否只审批：是；澄清 reviewer 只返回批准或结构化 violation。
3. 是否新增具体句式、商品名或类目 badcase：否；生产控制只读取类型化计划、状态和 receipts。
4. 是否出现第二条可写执行路径：否；无计划失败不会执行 UI focus、检索或澄清操作。
5. 模型、证据或系统不确定性是否仍可能包装成用户问题：P3 活跃路径已阻止；P4 仍需删除文件中已不可达的旧 fallback 残留代码。
6. 排序是否绕过 ESCI 准入：否；P3 未改变 P2 的 candidate admission 和 ranking 边界。
7. 新概念是否属于领域共识：是；uncertainty、clarification policy、answerability、guardrail 和 operation receipt 均为可解释职责，不引入通用 DSL 或项目黑话。

## P4 边界

P3 改变了活跃行为，但没有把清理工作冒充为完成：`conversation-policy.ts` 中旧的语义改写实现、`fallbackReply` 中提前返回之后的不可达恢复分支、历史 prompt 字段描述及 `TURN_REPHRASE` 兼容注册仍属于 P4 删除范围。
