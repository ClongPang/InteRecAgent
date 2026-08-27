# WP3 阶段审视：pi-agent Turn Orchestrator

## 完成范围

- 新建独立 `@interec/agent` workspace；每次 `executeConversationTurn` 都创建 fresh pi-agent，不保存进程内 transcript；
- `projectConversationContext` 只投影当前 USER batch、Goal、pending clarification/ops、最近邻接对、WorkingSet 受控摘要、capabilities/time/model/budget；
- context 去除真实 message/turn/assistant 数据库 ID、constraint/preference source、raw artifact、密钥和无限历史；当前消息全部保留 ordinal，单项与总输入预算 fail closed；
- model proposal 与 committed domain 类型分离：模型使用 `sourceMessageOrdinal`，宿主绑定为真实 `OperationSource`；`nextMoves` 使用同一绑定协议；
- pi-agent 阶段机只有 `commit_turn_plan → publish_reply` 两个模型可见工具；未知/旧工具、错 phase、漏提交和预算耗尽均 fail closed；
- 第一次 inference 提交有序 TurnPlan，确定性 host 在同一工具回调内按序执行 operation capability 并返回 receipt；普通话轮第二次 inference 发布 AssistantEnvelope；
- research 话轮最多 4 次 inference、3 次工具调用，允许一次回复自纠；常规话轮最多 2 次，超限使用确定性 fallback；
- `ConversationTurnDraftHost` 实现 ordinal binding、ConversationPolicy、Goal/Dialogue/WorkingSet reducer、undo、claim/evidence/question/disclosure allowlist 与安全 fallback；
- 所有 referent 在 plan commit 时基于同一个 observation WorkingSet 稳定成 offerRef，避免 reject/rerank 后 rank 漂移；
- `RepositoryTurnSession` 把 plan、每步 draft、reply/ledger/evidence staging 和最终原子 `commitTurn` 连接成单一路径；
- Provider/证据读取通过 `TurnWorldPort` 注入，Agent 包不包含 I/O 或 provider 特判。

## 测试证据

- `npm run test:unit`：14 个文件、183 项通过；
- Agent 测试覆盖 context 泄漏/截断/预算、两 inference 正常路径、有序 compound ops、free-text 漏工具、invalid ordinal、非法 phase tool、policy 拒绝 research、answer 自纠和硬预算 fallback；
- DraftHost 测试覆盖 observation-time referent stabilization、reject→rerank→inspect 不漂移、一个 Turn 只产生一个单调 Goal version、零 Provider policy 和 pre-plan durable fallback；
- 正式 PostgreSQL integration：15 项通过，其中包含 fresh faux pi-agent → plan staging → clarification draft → publish_reply → atomic Conversation revision/ASSISTANT message 的垂直切片，Provider 端口调用为 0；
- `npm run acceptance:v2`：183 项离线测试、全部 workspace（含 `@interec/agent`）类型和构建通过。

## 定位与偏移审视

本阶段实现的是“对话式推荐 Agent 的每话轮认知与编排核心”，不是把旧 research planner 改名：

- 输入是有界 ConversationSnapshot 和连续 USER batch，不是单条 query；
- 输出是可持久化 TurnPlan 与 AssistantEnvelope，不是一次性 Decision；
- pi-agent 拥有开放语言理解、复合计划与话语组织权；
- 确定性 host 拥有引用、事实、状态、Provider policy 和 final publication 权；
- talk/clarify/refilter/rerank/undo 路径天然可保持零 Provider；
- clarification/fallback 都发布 AssistantMessage 并保持 Conversation OPEN。

### Inference 预算裁决

原规划文字“commit plan 后每个 WorldOp 再暴露给模型调用”与“普通话轮最多 2 次 inference”不可同时满足：单操作至少需要计划、操作、回答三次。阶段裁决采用声明式编排：模型第一次通过 TurnPlan 选择并排序 capabilities，宿主在该工具回调内执行；模型第二次只组织回复。主规划已同步，不保留文档与实现双语义。

## Bad-case 审视

没有为“不要第二个”“第三个呢”写句式分支。复合话轮通过统一的 plan-time referent stabilization 解决：所有当前世界引用先绑定为稳定 offerRef，再按序执行 reducer。无论后续 reject、filter 或 rerank 怎样改变 display rank，已提交的后续 operation 都不会重绑。

同样，模型协议失败不是增加更多 retry case：常规预算内无法安全完成时统一编译 `fallback-clarification` TurnPlan，进入相同 draft/commit 路径。

## 明确未完成

- `TurnWorldPort.research/inspect` 仍是端口；真实 proof pipeline、artifact/FX claim chain、coverage wave、bulkhead/quota/circuit breaker 在 WP4；
- 因真实 world port 尚未完成，根 `dev:worker` 继续不暴露，避免启动半成品或旧 worker；
- 真模型 gold、外部 Provider 与浏览器验收仍在 WP7。

## 阶段裁决

WP3 达到进入 WP4 的条件。WP4 必须实现 `TurnWorldPort` 和 durable tool receipt，不得让模型直接构造 ComparableOffer/Claim，也不得在 research 成功前恢复旧 worker 入口。
