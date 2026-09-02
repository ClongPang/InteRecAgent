# ADR-0005：受业务策略约束的 Pi-Agent 规划

- 状态：Partially superseded. 计划审批与有界修复仍有效；ESCI 推荐准入由 ADR-0007 / ADR-0009 替代。
- 日期：2026-08-30

## 仍有效的决策

自然语言计划必须先过策略评审，再执行：

```text
Pi-Agent proposes QuoteTurnPlan
        ↓
reviewQuoteTurnPlan
   APPROVED → commit and execute
   REPAIR_REQUIRED → 一次有界修复
   耗尽或系统失败 → host-owned DEGRADED
```

策略只判断计划是否满足不变量，不得静默增删语义操作，也不得把模型协议失败改写成用户澄清。回复由宿主渲染，不再让模型提交第二份自由文本计划。

## 不要从本文恢复

ESCI 正式推荐/替代/互补分区、宿主生成完整计划、以及已删除的实现计划文件。现行策略在 `packages/domain/src/quote-plan-policy.ts`。
