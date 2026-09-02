# ADR 0010：生产 Provider Trace 与导出真实性

- 状态：Accepted / Implemented
- 日期：2026-09-02

## 背景与代码证据

生产报价链路是 `QuoteTurnDataService → QuoteLookupService → BuyWhereMcpQuoteClient.lookup → fetch /mcp find_best_price_v2`。重构前只有 FX client 使用 `observeTool`，BuyWhere 主依赖没有 Observation；测试曾手工创建 `discover_offers` / `buywhere.search`，不能证明线上可观测性。现行节点名见 `spec/observability/agent-trace-contract.json`。

领域 `PublishedQuoteLeadSet` 已含 `providerFailureCode`，但 `applyQuoteEffectResult` 的 `publicResult` 和 `DecisionProviderRecord` 丢弃该字段，导致根 `execute-turn-attempt` 无法区分 timeout、HTTP、网络及 contract drift。

遥测 exporter 批量异步发送。Worker 只在进程结束时 shutdown；API 通过 signal callback 启动未被主流程持有的异步 shutdown。迁移 0012 又为没有 Observation 的历史 turn/attempt 生成 MD5 trace ID，单靠 32-hex 格式无法证明 Trace 真实存在。

## 决策

1. `BuyWhereMcpQuoteClient` 的物理 `find_best_price_v2` 调用是 `tool.provider.buywhere.find_best_price_v2` TOOL；输出只记录闭集状态、失败码、retryable、记录数和契约版本，不记录原始响应。
2. `QuoteTurnDataService` 的逻辑 lookup 是 `turn_executor.quote-lookup` SPAN，覆盖缓存、permit、归一化、FX 和持久化。Host 与 receipt 共用 `providerInvocation: LIVE | ATTEMPT_REPLAY`，不再用布尔 `providerCalled` 同时表示“应用了报价观测”和“这次发了 HTTP”。
3. `providerFailureCode` 从 Published lead set 进入 operation receipt、DecisionProviderRecord 和根 Trace metadata；这是闭集诊断码，不依赖正文采集授权。`providerInvocation` 进入同一收据与决策记录，因此 provenance 契约当时升级为 `retail-price-turn-decision-v4`；现行决策身份字段见 `retail-price-turn-decision-v5`。物理 BuyWhere TOOL 记录 JSON-RPC `providerRequestId`，只作供应商对账，不进入决策通道。
4. Worker 每完成一个 durable turn 执行一次非严格 `forceFlush`：导出失败不得回滚已提交业务结果，但必须产生 metric 和 stderr 证据。Worker/API 的最终 shutdown 使用 strict 模式；API 主流程直接等待 signal 后顺序 await close 与 shutdown。
5. 数据库为 Trace ID 增加来源：`OBSERVED_ENQUEUE_ROOT` 或 `OBSERVED_ATTEMPT_ROOT`。迁移 0025 清除 0012 的合成 MD5 enqueue ID和复制到 attempt 的 enqueue ID；没有实际 Observation 的值保持 NULL。

## 理由与权衡

- Langfuse 把外部 API 调用定义为 TOOL；OpenTelemetry HTTP 约定要求网络、timeout 和 HTTP 错误具有可聚合的低基数 `error.type`。项目使用既有 provider failure code 作为稳定诊断词汇。
- 每 Turn flush 增加一次导出检查点开销，但把可能丢失窗口从“整个进程剩余批次”收缩到“正在执行的单 Turn”，且不把 exporter 可用性变成业务提交依赖。
- shutdown 无法抵御 SIGKILL、OOM 或机器掉电；因此不能宣称 exactly-once telemetry。目标是 bounded-loss、显式失败和可验证的 graceful shutdown。
- 清理历史合成 ID 会失去虚假的历史 enqueue 反查，但不会删除业务 turn、attempt、decision 或报价证据。保留它们反而会把不存在的 Trace 当作审计事实。

## 拒绝的替代方案

- 只在 telemetry 测试中继续造 Provider Span：不覆盖生产代码。
- 只把 `providerCalled` 改成 `!cacheHit`：用户回复、评测预算和决策记录对“本次是否有报价观测”的含义不同，布尔翻转会让 attempt replay 的 DEGRADED 抄成闲聊。
- 只给 host lookup 一个 TOOL：无法区分 cache、治理、网络和后处理延迟。
- 让 forceFlush 失败导致 Turn 重试：会把已提交业务结果与可丢失诊断投影错误耦合，并可能造成重复执行。
- 继续用格式合法的 32-hex 值表示历史 Trace：格式校验不能证明 Observation 被创建或导出。
