# ADR-0004：以 pi-agent Conversation Turn Runtime 实现对话式推荐

- 状态：Accepted for implementation；生产发布仍需完整验收
- 日期：2026-08-26
- 替代：ADR-0001 中 research-only 三工具话轮协议；不替代 ADR-0003 的正向证据准入原则

## 决策

InteRecAgent 的产品边界是长期 Shopping Conversation/Mission，而不是一次性推荐 run。每条用户输入形成一个 durable Turn；Turn 完成只表示已原子提交一条 AssistantMessage 和本轮状态变更，不关闭 Conversation。

每个 worker attempt 创建 fresh pi-agent。Agent 从 PostgreSQL 中指定 `baseRevision` 的受控 ConversationSnapshot 开始，依次完成：

```text
Observe → commit_turn_plan → ordered WorldOps → publish_reply
```

Agent 负责开放语言理解、多操作 TurnPlan、受限工具编排和 AssistantEnvelope 组织。宿主负责 Goal/WorkingSet reducer、引用绑定、外调策略、proof-carrying 资格、金额、排序、ClaimVerifier 和原子状态发布。

普通对话、澄清、比较、解释、排除、重排、过滤和撤销在现有证据足够时不得调用 Provider。澄清、无匹配和降级是 AssistantEnvelope outcome，不是 Conversation 终态。

## 状态与一致性

Goal、DialogueState、WorkingSet、AssistantMessage、可选 Decision、Turn status 和 conversation events 必须在一次最终事务中 exactly-once publication。所有中间操作写入 attempt-scoped TurnDraft；失败、取消、超时或 superseded attempt 不能成为 Conversation “latest”。

外部调用允许 at-least-once。工具使用 stable step key 和 request hash 的 durable ledger；已成功步骤可重放，状态晋级仍受 base revision、attempt、fence 和有效 lease 约束。

## 不兼容决策

- 删除当前 `commit_turn → discover/inspect → Decision` 作为完整话轮的协议；
- 删除每个成功 Turn 必须产生 Decision 的假设；
- 重建支持 USER/ASSISTANT 的消息账本、ConversationRevision 和 WorkingSet；
- 直接替换当前 `/v2` 单轮 API 和一次性前端；
- 不恢复旧 Python/LangGraph 主链，不双写，不保留旧引擎开关；
- 旧代码只作为产品行为证据和 trajectory 语料。

## 验收依据

权威产品行为由 `spec/conversational-agent-product-contract.json` 定义。任何实现必须先通过机器校验，再通过领域、pi-agent contract、PostgreSQL、API/SSE、浏览器和真实多轮 Provider 验收。

详细设计、工作包和发布门槛见 `docs/pi-agent-conversational-agent-refactor-plan.md`。
