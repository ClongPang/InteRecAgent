# ADR-0004：以 pi-agent Conversation Turn Runtime 实现可恢复对话

- 状态：Partially superseded. Durable Turn runtime 仍有效；跨市场推荐产品语义由 ADR-0007 替代。
- 日期：2026-08-26

## 仍有效的运行时决策

每条用户输入形成一个可由 PostgreSQL 租约接管和恢复的 Turn。Turn 完成只表示已原子提交本轮 Assistant message 和状态变更，不关闭 Conversation。

每个 worker attempt 创建新的 pi-agent，从指定 `baseRevision` 的受控快照开始。中间结果写入 attempt-scoped draft；失败、取消、超时或 superseded attempt 不能成为 Conversation latest。

外部调用允许 at-least-once，用 stable step key 与 request hash 的 durable ledger 重放；状态晋级仍受 base revision、attempt、fence 和有效 lease 约束。

## 现行话轮协议

```text
Observe → commit_quote_plan → host review / domain decide / effects → host-rendered reply
```

模型只提交受审 `QuoteTurnPlan`。宿主拥有 Provider 调用、状态变更和用户可见回复。比较、聚焦、排除和解释在已有观测足够时不得调用 Provider。

## 不要从本文恢复

Goal/WorkingSet 推荐合同、双工具发布协议、以及“每个成功 Turn 必须产生 Decision”的假设。现行产品合同是 `spec/quote-lead-product-contract.json`。
