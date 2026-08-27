# WP2 阶段审视：Conversation schema 与原子 repository

## 完成范围

- 新建单一正式 schema `interec_agent`，没有向 `interec_v2` 双写；
- Conversation 行持有 authoritative `current_revision`、active Turn、message/event 原子计数器；
- USER/ASSISTANT message 与 system event 分表，AssistantResponse 与 ASSISTANT message 严格一对一；
- Turn 使用技术状态、attempt、fence、数据库 lease/deadline；Assistant outcome 不再冒充 Turn 终态；
- 接收事务只写 USER message、Turn、input batch 和 event，不提前修改 Goal/Dialogue/WorkingSet；
- 新纠正 Turn supersede 活跃 Turn，并按 seq 收集自上次成功发布后所有未消费 USER messages；
- attempt draft、evidence allowlist 和 TurnPlan 隔离保存；final commit 强制逐字段匹配当前 attempt draft；
- final commit 使用 PostgreSQL `clock_timestamp()` 条件切换到 `COMMITTING`，同时校验 base revision、attempt、fence、lease 和 deadline；
- final transaction 一次性发布 Goal/Dialogue/WorkingSet version、ConversationRevision、AssistantResponse/Envelope/ClaimLedger、ASSISTANT message、可选 Decision、消费标记、Turn/attempt 状态和 event/outbox；任一步失败全部回滚；
- Goal/WorkingSet 新版本使用 Conversation publication revision 单调前进；undo 创建新 Conversation revision，但精确复用目标 revision 的状态指针；
- stable tool receipt 使用 `stepKey + canonical request hash`，支持崩溃前重试、成功结果复用和同 step 异 request 拒绝；
- 第三次 attempt lease 失效后进入 `DEAD_LETTER`，旧 fence 和旧 attempt 结果不能发布；
- migration 使用编号文件、SHA-256 checksum、PostgreSQL advisory lock、单迁移事务和表/列/关键约束/index verifier；已应用 migration 不回改，FK 修复通过 0002 追加。

## 测试证据

- `npm run test:unit`：11 个文件、168 项离线测试通过；
- 新 Conversation PostgreSQL 合约：14 项全部通过；
- 覆盖 canonical idempotency、同 key 异 payload、expected revision、双 worker、lease/fence、heartbeat、failed/cancelled/superseded draft 不可见、过期 lease commit 拒绝、连续未消费消息 batch、原子提交重放、晚期校验全回滚、工具回执崩溃恢复、attempt 耗尽、并发 event seq、SSE cursor、旧 attempt evidence 不晋级、精确 undo、migration 并发锁/checksum；
- `npm run acceptance:v2`：产品契约、架构、工作流、类型、离线测试和全部 workspace build 通过；
- 本地 migration 首次应用 `0001`/`0002` 后重复执行不重放，schema verifier 通过 15 个核心表；
- 新 schema 检查未发现 `MAX(seq)+1`、`CREATE ... IF NOT EXISTS` 或 `interec_v2` 引用。

## 定位与偏移审视

本阶段没有把 repository 继续设计成“一次搜索 run 的存储层”：

- authoritative 边界是长期 Conversation revision；Turn 只是一次执行；
- 输入是有序 USER message batch，不是 latest-message-only；
- Goal、WorkingSet、Dialogue 和 AssistantMessage 只在 final commit 一起可见；
- Provider/tool result 是 attempt audit，不等于可推荐事实，也不能单独推动 Conversation revision；
- undo 不是字段逆运算，而是经过验证的历史指针恢复；恢复后再修改形成单调新分支，不覆盖旧版本。

旧单轮 worker/API/live 入口已从根命令和 CI 移除。旧源码与旧 schema 仍作为尚待 WP8 删除的 rejected baseline 留在工作树/本地数据库，但没有新写入、兼容 adapter 或双写路径。

## Bad-case 审视

实现没有针对首页“开始比较”或某条错误消息增加 repository 特判。此前问题背后的共同机制被统一处理：

1. `NOT_FOUND` 不再通过默认候选掩盖，状态只能引用已发布 WorkingSet；
2. 页面无反应所对应的“终态/消息不可见”问题，由原子 AssistantMessage publication 和 conversation event cursor 解决；
3. 用户纠正时不丢前文，由未消费 USER batch + supersede/fence 解决；
4. 失败尝试污染下一轮，由 attempt draft + exact final promotion 解决；
5. 并发事件冲突由 Conversation 行计数器解决，而不是重试 `MAX(seq)+1`。

阶段内主动发现并修正了：Conversation 聚合删除 FK、应用时钟 lease 判断、名义 staged draft、undo 后版本碰撞、旧 CI/live 入口仍可执行等架构问题，均通过通用约束修复。

## 明确未完成

- outbox 目前只有原子写入，publisher/retry/backlog 在 WP5；在此之前不宣称事件已外部可靠投递；
- provider artifact/source fact/FX 的数据库 FK 与 TTL cleaner 在 WP4；当前 ClaimVerifier 只允许 attempt evidence key，不能替代完整 claim chain；
- server-bound JWT claims、owner isolation/RLS、readiness 和 Conversation API 在 WP5；
- 新 worker/API/UI 尚未启用，真实模型、Provider 和浏览器验收在 WP7。

## 阶段裁决

WP2 达到进入 WP3 的条件。WP3 只能通过 `ConversationRepository` 和 attempt draft/final commit 协议执行，不得复用旧 `RunStore`、提前 commit Goal/ComparisonSet，或绕过 durable tool receipt 直接外调。
