# WP7 阶段审视：轨迹评测与真实验收（进行中）

## 已取得的证据

- 11 条可执行离线多轮轨迹与正式 DraftHost、referent binder、ConversationState 和 WorkingSet 共用实现；覆盖澄清、恢复、零外调比较、多操作话轮、本地重排、改目标、撤销、UI focus、刷新恢复和证据解释。
- 产品契约门禁识别 12 个不变量、13 条多轮轨迹与 12 条零 Provider 路径。
- PostgreSQL/API 集成测试 2 files / 23 tests 通过；单元/契约测试 16 files / 105 tests 通过。
- 当前常驻 API、worker、PostgreSQL、Vite 全栈健康。通过正式 API 提交 typed `PATCH_GOAL` 后，Turn `COMPLETED`，revision `0 → 1`，USER/ASSISTANT 账本完整且目标状态持久化。
- `acceptance:runtime-smoke` 将该纵切固化为显式确认的零外调验收，并额外验证缺失 JWT 返回 401、其他 owner 返回 404；最近一次执行状态为 `COMPLETED`、revision 1、外部调用 0。
- `live:turn:once` 提供显式授权、精确 UUID、单次退出且不扫描队列的真实模型验收入口；该入口的安全门禁已测试，但尚未触发外部调用。
- `acceptance:gold` 只接收 `REAL_MODEL_HUMAN_REVIEWED` 且 Conversation ID 唯一的结果，执行 100/50 样本量、关键轨迹、版本一致、事实安全、route/multi-op、referent 与澄清恢复阈值；不会把离线或 typed 结果计入 gold。
- `acceptance:shadow` 只接收 `REAL_SHADOW` 且 Conversation ID 唯一的结果，执行 1000 Turn、200 个 3+ 轮 Conversation、100 Turn 双审与单版本门槛；各 route 最小配额必须来自单独评审的 policy，不能由统计脚本临时猜测。
- 正式 Turn、route、API enqueue/projection、queue、SSE、pi-agent、Provider 与 Outbox 指标已接入执行路径；机器门禁覆盖 21 个低基数指标、11 个 Grafana 面板和 12 条 Prometheus 告警。目标环境真实收数与告警送达仍待验收。
- 指标使用延迟绑定，避免 OpenTelemetry provider 启动前创建 NoopMeter 导致“声明存在但永不导出”；内存 exporter 契约测试已验证真实 metric data 导出。
- Turn 终态指标由 PostgreSQL repository 在权威事务提交后记录，覆盖 completed/failed/cancelled/timed-out/superseded/dead-letter；精确 live Turn 领取不会触发全局过期扫描或修改无关队列。
- `acceptance:operations` 要求 `TARGET_ENVIRONMENT_OBSERVED` 证据，机器校验面板收数、全部告警送达、on-call 确认、内容泄漏检查、实际 snapshot restore、RTO/RPO、revision/event cursor、完整性检查和双人批准；缺少真实演练时必然失败。
- gold、Shadow 与运维证据必须分别匹配显式指定的 release/model/environment，拒绝复用其他版本的绿报告。
- runtime smoke 曾捕获 Turn 已 `COMPLETED` 但 Projection 仍拼入 revision 0 的撕裂读取；根因是 Conversation、state、messages 与 Turn 由多个独立事务并发读取。现已由 repository 提供 owner-scoped `REPEATABLE READ READ ONLY` Projection 快照，API 不再自行拼接多个时点。
- 修复部署后连续执行 5 次零外调 runtime smoke：均为 `COMPLETED`、Conversation/state revision 1、USER→ASSISTANT、owner isolation 404，未再次出现撕裂视图。

## pi-agent 定位复核

离线轨迹没有建立第二套简化 Agent。自然语言轨迹仍使用正式 TurnPlan、ordered WorldOps、AssistantEnvelope 与确定性宿主边界；typed control 只覆盖 UI 的确定性操作，不计作真实模型 gold。当前证据证明运行协议和状态机，不证明模型语义质量。

## 尚未满足的发布门槛

- in-app Browser 当前没有可用 browser instance，因此桌面、移动、焦点、断线恢复和真实点击链路尚未形成浏览器证据。
- 未经用户明确批准，不发送人工测试文本到已配置的外部模型或商品 Provider；因此真实自然语言单 Turn 与多轮 gold 尚未执行。
- 100 条真实模型 gold（其中 50 条 3+ 轮）、1000 Turn/200 Conversation Shadow、100 条人工双审均未达到。
- 目标环境 Dashboard、告警、on-call 值守证据和实际回滚演练未完成。

## 漂移检查

- 不把 typed E2E、faux provider 或离线 trajectory 计入真实模型 gold。
- 不因一次 live 成功降低样本门槛，也不为单个 bad case 添加内容特判。
- 浏览器和外部服务不可用时保留明确的未验收状态，不使用源码检查或 HTTP smoke 冒充浏览器验收。

WP7 保持进行中，不允许发布。
