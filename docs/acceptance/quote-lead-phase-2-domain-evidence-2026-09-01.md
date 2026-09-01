# 报价线索重构阶段 2：领域、证据与持久化审批

日期：2026-09-01  
目标合同：`quote-leads-sg-v1`  
审批结论：`APPROVED`

## 本阶段交付

- `QuoteTarget`：只允许 NFKC、大小写、空格和标点规范化；型号字母或数字变化不能静默通过。品牌、商品类型和限定词必须存在于可审计的输入文本中，型号显式确认不能夹带额外查询上下文。
- `QuoteObservation`：BuyWhere 返回的每条记录都保留；字段缺失、不安全 URL、配件、服务或型号冲突只改变准入结论，不删除原始记录。
- 严格准入：完整型号、品牌、必要限定词、主商品角色、用户明确指定的成色和商业字段均为硬门禁；不使用编辑距离、语义相似度或 Provider availability 放宽门禁。
- `QuoteLead`：仅对已准入 observation 按“规范化商家目标 URL + 成色”分组；保留全部 observation 引用和各原币价格区间，不把记录数表达为商家数。
- FX：原币事实独立成立；只有合法、币对一致且时间窗口有效的 FX snapshot 才能产生 CNY 估算，FX 失败不会删除原币线索。
- 证据：每个可见标题、原币区间、商家域名、目标页、跳转页、成色、记录数和时间声明均绑定 source fact；CNY 声明额外绑定 FX snapshot。
- PostgreSQL `0019_quote_leads.sql`：报价线索集、原始 artifact、observations、FX、leads、observation 关系、source facts、claims 和 claim evidence 使用独立报价表；启用 RLS、不可变触发器和复合外键。
- Repository：在校验有效 turn/attempt fence、租约和 deadline 后，以一个事务写入完整报价证据图；迟到 worker 无法写入，后段错误会完整回滚。

## 真实 BuyWhere 事实复核

所有调用均使用 MCP v2 `find_best_price_v2`，adapter 内部固定 `deliver_to=SG`；未使用 mode、`search_products_v2` 或 REST fallback。

1. `Sony WH-1000XM5 headphones`
   - 观测时间：`2026-09-01T03:48:40.894Z`
   - Provider 状态：`OK_RESULTS`
   - 原始记录：9
   - 实际结构：9 条记录具有同一规范化商家页和相同 `REFURBISHED` 成色；原币均为 USD，区间 `215–249.99`
   - 决策影响：未指定成色时默认必须是 `ANY` 并明确展示成色，不能擅自假设“全新”；指定成色时仍执行硬过滤。
   - 冻结证据：`packages/runtime/test/fixtures/buywhere-wh1000xm5-2026-09-01.json`
   - 隐私处理：保留选定商业字段；Provider ID 哈希化；移除追踪参数和 outbound redirect；文件同时保存原始 artifact hash 和观测时间，且没有 API key。

2. `Sony WH-1000XM5 replacement ear pads`
   - 观测时间：`2026-09-01T03:49:10.077Z`
   - Provider 状态：`OK_EMPTY`
   - `meta.emptiness_reason=only_accessories_matched`
   - 结论：BuyWhere 当前可能在工具内部过滤仅配件结果；系统仍保留自身配件硬门禁。这个响应属于 Provider 正常空结果，不得改写成 degraded 或“市场没有销售”。

3. `Nintendo Switch display repair service`
   - 观测时间：`2026-09-01T03:49:23.319Z`
   - Provider 状态：`DEGRADED`
   - `meta.status=degraded`、`emptiness_reason=timeout`、failure `BUYWHERE_DEGRADED_TIMEOUT`
   - 结论：真实 HTTP/MCP 成功 envelope 仍可能是退化状态；不得发布 `NO_QUOTE_LEADS`。

这些是特定时刻的 Provider 观测，不外推为 BuyWhere 永久覆盖率、当前库存、最低价或可购买性保证。

## 审批复核

### 实现审查

通过。领域规则、Provider adapter、FX、证据投影和持久化单向依赖；没有把报价表伪装成旧的 recommendation research wave，也没有引入搜索 fallback。

### 行为审查

通过。覆盖了精确型号、型号字符冲突、配件、维修、替换件、限定词、成色、不安全 URL、Provider 正常空、全部记录被拒绝、degraded、FX 成功与失败、同页重复记录和真实 BuyWhere 回放。

### 事实审查

通过。原始 provider envelope hash、记录、meta、observed time、准入原因、分组关系、原币和 FX 均分层保留；availability 没有进入 claim 或排序。

### 可维护性审查

通过。报价目标、observations/准入、分组、lookup orchestration、provenance 和 repository 为独立职责文件；维护性门禁限制三个 runtime façade 的行数和依赖方向。

### 漂移审查

通过。`quote:drift:check` 在 phase 2 检查领域模块、repository、0019 迁移、严格准入 reason code、状态区分、事务/fencing 标记和 observation 关系。

## 可复现门禁结果

- `npm run quote:contract:check`：通过；18 invariants、10 trajectories、8 个零 Provider turns、14 个 Provider turns。
- `npm run quote:drift:check`：通过；phase 2、目标 `quote-leads-sg-v1`。
- `npm run architecture:maintainability:check`：通过；6 façades、15 responsibility modules。
- `npm run typecheck`：通过。
- `npm run test:unit`：通过；49 files、360 tests。
- `npm run test:integration`：通过；3 files、30 tests；包括新增的原子事务、完整回滚、RLS、fencing 和 observation membership 用例。
- `npm run lint`：通过。

## 未在本阶段冒充完成的事项

- 本阶段保存的是 fenced、原子写入的 `DRAFT QuoteLeadSet`；与 assistant message、conversation revision 和 event 的最终原子发布属于阶段 3。
- Agent operations、Prompt/schema、API projection、UI 卡片、多轮引用与刷新语义尚未切换；阶段 3 前旧业务仍是活动实现。
- 真实目录会变化；9 条记录、单一商家页和 USD 区间是冻结观测，不是永久验收阈值。
