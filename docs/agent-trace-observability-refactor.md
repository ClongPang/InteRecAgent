# Agent Trace 可观测性：现行边界

- 状态：Implemented
- 日期：2026-09-02
- 合同：`spec/observability/agent-trace-contract.json`（`retail-price-agent-trace-v4`）
- 决策记录：ADR-0002、ADR-0010

PostgreSQL 是业务事实源。Langfuse / OTel 是诊断投影，导出失败不得改变 Turn 终态。

## 现行树

```text
conversation-turn-enqueue          独立 root：请求是否被持久化接受   tag=turn-enqueue
execute-turn-attempt               独立 root：本次 attempt 的真实工作 tag=turn-attempt
  planner.plan / planner.repair-plan
  agent.tool.commit_quote_plan
    turn_executor.quote-lookup     LIVE | ATTEMPT_REPLAY
      tool.provider.buywhere.find_best_price_v2   仅 LIVE
      tool.resolve-exchange-rate                  需要 FX 时
  validate-agent-tool-causality
  enforce-safety-boundary          fallback 时
```

enqueue 与 attempt 不是父子。attempt 用 `causedByTraceId` / `causedByObservationId` 和 OTel span link 指向 enqueue。Conversation 用 HMAC `sessionId` 聚合。数据库只持久化 `OBSERVED_ENQUEUE_ROOT` 与 `OBSERVED_ATTEMPT_ROOT`；没有实际 Observation 时 `trace_id` 为 NULL。

## 三通道投影

| 通道 | 开关 | 内容 | 给谁看 |
| --- | --- | --- | --- |
| `view` | 始终 | OpenAI 消息对。关正文时用户侧 `[CONTENT_NOT_CAPTURED]`，助手侧 `outcome \| route \| lifecycle \| catalogIdentity` | Langfuse 列表 / Session / 评测 I/O |
| `decision` | 始终 | `retail-price-turn-decision-v5`：闭集 why + `targetRef` / `modelKey` / `canonicalModel` | 过滤、轨迹同构、跨轮改型号 |
| `content` | `RETAIL_PRICE_LANGFUSE_CAPTURE_CONTENT` | 脱敏后的用户原话、助手回复、generation/tool 正文 | 授权排障 |

目录身份是注册表 token，不是用户原话。`Sony WH-1000XM5 headphones` 进不了 decision；`WH-1000XM5` 可以。

## 必须能解释的东西

1. **边界真实**：一条 Trace 是一个有开始和结束的工作单元。
2. **因果闭合**：`tool_call → host 执行 → 模型可见 result → 下一次 generation` 由 `AgentCausalityLedger` 校验。终止型 `commit_quote_plan` 不要求再进入下一次 generation。
3. **语义可比较**：generation manifest 在 `streamFn` 边界对 Provider 可见输入做键排序摘要；生产用 HMAC-SHA-256。
4. **可读**：Generation 使用 OpenAI 兼容消息；assistant 用 `tool_calls`，tool 用 `tool_call_id`。根 I/O 也是同一形状。
5. **决策通道**：闭集词汇，独立于正文开关，含目录身份。
6. **评测**：`scoreQuoteTurnDecision` 与轨迹脚本同构。Langfuse dataset / LLM-as-judge 未做。
7. **隐私**：正文默认采集并脱敏密钥。关正文时只丢正文，不丢 view/decision。隐藏思维链始终不采集。

## Provider 三层词汇

| 层 | 字段 | 含义 |
| --- | --- | --- |
| 用户回复 | LIVE / ATTEMPT_REPLAY | 本轮是否应用了报价观测 |
| 评测 / 预算 | `providerCalled` | 仅 LIVE 为 true |
| 物理 TOOL | `providerRequestId` | 这次 BuyWhere JSON-RPC `id` |

## 导出

Worker 每完成一个 durable turn 做一次非严格 `forceFlush`。API/Worker 优雅退出时 strict `shutdown`。仓库门禁：`npm run observability:check`。发布证据：`npm run observability:smoke` 的真实 Langfuse 回读。

## 不要再做的旧设计

- 用已结束的 enqueue span 当 Worker 父节点。
- 给 turn/attempt 写合成 MD5 `trace_id`。
- 关正文时把整个根 input 收成 `{contentCaptured:false}`。
- 为了列表好看而把用户原话写进始终采集通道。
- 用已删除的双工具协议或假 Provider span 名冒充生产节点。
- 把 `providerCalled` 同时解释成“有观测”和“发了 HTTP”。
