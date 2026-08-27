# WP4 阶段审视：Research 与 proof pipeline

## 完成范围

- `ConversationResearchWorld` 已作为正式 `TurnWorldPort` 接入新 Conversation/Turn 主链；旧 `interec_v2` research repository/handler 没有被适配回主链。
- Research campaign 支持最多两波查询、稳定 listing 合并、Coverage 统计与 `COVERAGE_SATISFIED / ALL_PROVIDERS_FAILED / NO_NEW_COMPARABLES / MAX_WAVES_REACHED` 停止条件。
- WorkingSet 只接收 proof gate 晋级的 ComparableOffer；ComparisonSet 使用 Conversation-scoped 单调版本，并在 final commit 中与 WorkingSet 原子晋级。
- 每个 provider artifact、source fact、FX snapshot、qualification、attempt claim 和 claim evidence 都归属具体 Turn attempt。失败、取消、超时或 superseded attempt 不具备发布权限。
- final commit 除领域 ClaimVerifier 外，再逐条回查数据库 proof chain，要求 evidence 的 artifact、JSON path、canonical value、schema/policy、observedAt、derivation 和 FX 引用完全一致。
- 已晋级 source fact、FX、ComparisonSet 与 published claim 禁止更新；artifact 过期后只允许清空 raw payload，哈希和来源元数据保持不变。
- provider 调用在外调前通过 PostgreSQL 原子 permit 实施 cluster bulkhead、tenant concurrency/RPM/day quota、per-turn retry budget 与 circuit breaker；调用结果使用 stable tool step receipt 支持 crash 后 REUSE。
- raw query 不进入 durable receipt，只保存 query hash。artifact TTL cleaner 同时清理过期 payload 和 receipt 中的 raw provider result；已发布 source fact/claim chain 保留。

## 测试证据

- 离线单元门禁：14 个文件、184 项通过。
- Conversation PostgreSQL 集成：17 项通过，包含双 worker、lease/fence、attempt crash、research campaign、partial provider failure、proof promotion、normalized published evidence、证据不可变、TTL scrub 与 provider 治理。
- 全离线验收：产品契约 12 invariants / 13 trajectories / 12 zero-provider turns；architecture、workflow、typecheck、全部 workspace build 通过。
- proof kernel 继续覆盖：未验证低价不改变主推荐；市场冲突、配件、错误型号、成色不一致全部 fail closed。

## 定位与偏移审视

本阶段没有把 pi-agent 退化成搜索脚本：Agent 仍负责开放语言理解、TurnPlan 和回复组织；Research 是受限 WorldOp，事实、金额、身份、资格、排序与发布权仍在确定性宿主。

WorkingSet 仍是长期可指代候选世界，ComparisonSet 只是一次 proof-qualified 切片。普通解释、筛选、重排、排除与比较可复用已晋级证据，不能因为接入 provider 就默认每轮重搜。

本阶段修复的是统一不变量，而不是为具体商品堆补丁：证据路径变成 artifact 内精确 `$.data[index]...`；型号进入资格内核前统一规范化；并发 claim 在原子 UPDATE 时重检资格；Assistant 只发布实际引用的 verified claim。

## 明确未完成

- 新 worker/API 的进程组合、ConversationProjection、SSE、身份绑定、RLS/readiness/outbox publisher 属于 WP5；当前仍不暴露半成品启动命令。
- UI 对话工作台属于 WP6；真实模型、真实 Provider、浏览器端到端、gold/shadow/SLO 属于 WP7。
- 旧 `interec_v2` 文件和环境变量只作为 rejected baseline 留待 WP8 删除，不是 fallback 或双写路径。

## 阶段裁决

WP4 达到进入 WP5 的条件。下一阶段必须围绕 ConversationProjection + durable Turn API/SSE 组合服务，不得恢复旧 Decision-per-run API，也不得让浏览器自报 tenant/owner 身份。
