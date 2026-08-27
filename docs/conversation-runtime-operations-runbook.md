# Conversation Runtime 运维与可观测性手册

## 正式运行面

InteRecAgent 只有一套运行时：Conversation API、durable Conversation worker、PostgreSQL `interec_agent` schema、React Conversation UI。禁止回退到旧 Python 或 Run/Decision 协议。

```text
UI → Conversation API → PostgreSQL → durable worker
                                      └─ fresh pi-agent → deterministic host → atomic publication
```

进程入口：

```bash
npm run dev:api
npm run dev:worker
npm run dev --workspace frontend
```

## 健康与就绪

- `GET /health/live`：只证明 API 进程存活。
- `GET /health/ready`：验证数据库连接、migration checksum 和关键 schema 对象。
- Worker 健康由最近 claim/heartbeat、队列等待和 expired lease 接管共同判断，不能用“进程存在”替代。

## Trace 模型

每次 durable Turn 产生一个 `shopping-recommendation-turn` Agent trace，session ID 为 Conversation ID。子观察至少包含 pi-agent inference、`commit_turn_plan`/`publish_reply` 工具、Provider 请求和确定性 host 操作。

默认 `INTEREC_LANGFUSE_CAPTURE_CONTENT=false`。关闭时不得发送用户消息、prompt、模型输出或 Provider payload；只记录状态、模型、调用次数、耗时、错误码和脱敏关联字段。用户 ID 必须使用 `INTEREC_TELEMETRY_PSEUDONYM_KEY` 的 HMAC，不允许无密钥 hash。启用内容采集必须具备 tenant consent、DLP 和保留期限。

合成连通性 smoke 不发送业务请求：

```bash
INTEREC_LANGFUSE_SMOKE_CONFIRM=authorized-single-trace npm run observability:smoke
```

## 单 Turn 真实模型验收

真实验收必须先暂停常驻 worker，再通过已认证的 Conversation API 创建且人工核对一个测试 Turn。仅在确认测试文本、目标模型与 Provider 外调都已获授权后，执行精确领取：

```bash
INTEREC_LIVE_TURN_ID=<exact-turn-uuid> INTEREC_LIVE_TURN_CONFIRM=authorized-external-turn npm run live:turn:once
```

该入口拒绝缺失/非 UUID Turn ID，只调用 `runOnce(turnId)` 一次，不扫描队列。完成后应通过 API、PostgreSQL ledger 和 trace 三方核对终态、revision、AssistantMessage、工具调用次数及证据引用，再恢复常驻 worker。

## 核心指标与 SLO

| 指标 | 初始门槛 |
| --- | --- |
| API enqueue P95 | `< 300 ms` |
| Conversation projection P95 | `< 500 ms` |
| SSE lag P95 | `< 1 s` |
| talk/refilter P95 | `< 8 s` |
| research P95 / P99 | `< 45 s / < 60 s` |
| queue wait P95 | `< 2 s` |
| lease 接管 | `< 20 s` |
| system failure / timeout | `< 1% / < 1%` |

Dashboard 至少展示：Turn 吞吐和终态、route、queue wait、attempt/lease takeover、pi-agent inference/tool calls、Provider latency/error/quota/circuit、proof qualification、claim validation failure、SSE lag、outbox backlog/dead letter。

指标契约、Prometheus 告警和 Grafana 面板分别位于 `spec/observability/metrics-contract.json`、`ops/prometheus/conversation-alerts.yml` 与 `ops/grafana/conversation-runtime-dashboard.json`。`npm run observability:check` 校验声明、实际记录点、低基数标签和面板/告警覆盖。仓库校验不能替代目标环境 OTLP 数据、告警送达和人工确认。

## PostgreSQL 排障

所有业务查询必须在受控 owner 或 worker 角色下执行。以下语句只用于受限运维会话：

```sql
SELECT status, count(*)
FROM interec_agent.turns
GROUP BY status
ORDER BY status;

SELECT id, conversation_id, status, attempt, error_code,
       lease_expires_at, deadline_at, created_at, completed_at
FROM interec_agent.turns
WHERE id = :turn_id;

SELECT seq, event_type, public_payload, created_at
FROM interec_agent.turn_events
WHERE conversation_id = :conversation_id
ORDER BY seq;

SELECT topic, count(*) AS backlog,
       count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_letters
FROM interec_agent.outbox
WHERE published_at IS NULL
GROUP BY topic;
```

不得手工修改已晋级的 source facts、FX、ComparisonSet 或 published claims；不可变触发器报错代表安全边界生效。

## 告警与响应

- P0：跨租户读取、secret/content leak、无证据事实、硬约束违规、错品类推荐或状态回退。立即暂停新外调与发布，保留 ledger，禁止切回旧引擎。
- P1：system failure/timeout 超门槛、SSE 严重滞后、队列/Outbox 持续增长、Provider circuit 长期开启。先缩小 Provider/品类能力，再检查首个失败事件和 trace。
- P2：单 Provider 或单市场降级。保留已验证 WorkingSet，明确披露 coverage，禁止把 unavailable 描述成 no match。

## 回滚

发布前 drain worker、阻断新写并创建数据库快照/PITR checkpoint。回滚单位是部署版本和数据库恢复点，目标 RTO `≤30 min`、RPO `≤5 min`；kill switch 只能暂停外调或缩小能力，不能恢复旧实现。

回滚演练必须记录：部署版本、checkpoint、最后可接受 revision/event cursor、drain 时长、恢复时长、数据校验结果和批准人。未完成实际演练前不得把此文档视为“回滚已验收”。

目标环境证据使用 `spec/observability/operations-acceptance-policy.json` 作为门槛，并通过 `INTEREC_OPERATIONS_EVIDENCE_PATH=<reviewed-json> npm run acceptance:operations` 校验。证据必须来自真实目标环境，覆盖所有要求面板和告警送达、on-call 确认、内容泄漏检查、实际 snapshot restore、RTO/RPO、revision/event cursor 一致性、完整性检查和双人批准；不得包含 prompt、query、用户内容或凭据。
