# 报价线索重构阶段 5：真实 BuyWhere 多用例验收与完成审计

日期：2026-09-01  
目标合同：`quote-leads-sg-v1`  
当前审批状态：`APPROVED`

## 本阶段结论

真实 BuyWhere 多用例报告与默认全量门禁均已得到 `PASS`，阶段审批结论为 `APPROVED`。现有证据支持的产品结论严格限定为：这是一个面向新加坡、针对已知商品型号、提供报价线索并要求用户前往商家页确认的对话助手。

真实调用只证明了本次观察窗口中的请求与返回事实。它不证明 BuyWhere 具有稳定目录覆盖、关键词/模糊/语义搜索模式、实时库存、最终成交价、配送结果或商家页当前可购买性。

## 最终重构决策及理由

1. **固定服务范围为新加坡，不收集配送目的地。** BuyWhere adapter 内部固定 `deliver_to=SG`，用户模型和活动 API 中没有配送目的地字段。理由是新加坡属于产品服务边界，不是每轮购物任务中需要重新推断的用户目标；让用户选择目的地会重新引入已经否决的跨市场推荐问题。
2. **只服务已知型号；型号不确定时只澄清。** 型号字母或数字发生变化时不能静默纠错，明显错拼用例不得调用 Provider。理由是相近型号可能对应不同商品，错误召回的低价会形成比“没有结果”更严重的购买误导。
3. **报价主链路只调用 `find_best_price_v2`。** 实际请求只观察到 `product_name` 与 `deliver_to` 两个参数，没有发送或发现 keyword、fuzzy、semantic、hybrid、sort 等显式模式参数，也没有使用 `search_products_v2` fallback。理由是没有契约证据就不能将推测的搜索能力变成产品承诺；自动 fallback 还会改变空结果与故障的语义。
4. **将 Provider 原始记录与用户报价线索分层。** 每条原始记录先成为 `QuoteObservation`，通过确定性准入后才可进入 `QuoteLead`。理由是 Provider 返回只能证明“观察到一条记录”，不能直接证明型号正确、是主商品、当前有货或可成交。
5. **身份准入采用硬门禁。** 型号、必要限定词和 item role 必须满足；配件、替换件、维修与服务记录显式拒绝并保留原因。理由是排序或语义相似度无法修复身份错误，且审计必须能解释为什么某条记录没有展示。
6. **按规范化商家页 URL 与成色分组，不做推荐排名。** 同一商家页的多条 observation 聚合为一个线索，并保留 observation 关系。理由是返回记录数不等于商家数；把 Provider availability 或记录重复度用于排名会伪造“更可靠”或“更有货”的含义。
7. **原币价格为主要事实，CNY 仅为带时间的可选估算。** FX 失败不得删除原币报价。理由是真实结果已出现 USD，汇率是不同时间来源的派生事实，不应覆盖或冒充商家原始报价。
8. **Provider 状态必须四分。** `OK_RESULTS`、`OK_EMPTY`、`DEGRADED`、`FAILED` 分开保存和呈现；timeout、HTTP 502、engine degraded、circuit-open 都不能转成“没有报价”。理由是真实 24 小时审计窗口同时出现成功、空、退化和失败，二值结果会把基础设施问题错误描述成市场事实。
9. **对话调用次数由确定性策略控制。** 首次已确认型号与显式刷新可调用 Provider；比较、聚焦、排除和解释现有线索保持零 Provider 调用，刷新产生新 observation。理由是 LLM 不能自由制造查询或将历史审计数据重新发布为当前报价。
10. **公开回复只表达报价线索与商家页确认。** 卡片显示原币、可选 CNY、商家域名、成色、观察时间和 HTTPS 商家页入口；不发布“全网最低”“当前有货”“可以购买”或配送结论。理由是这些事实没有由 BuyWhere 报价记录和本系统观察共同证明。
11. **持久化保留证据关系，但旧业务只读退役。** 新会话只使用 `quote-leads-sg-v1`；旧推荐会话可识别但不可 claim 或继续写入。理由是既要保留审计数据，又不能长期维护两套活动业务语义。
12. **保持单一实现和职责边界。** Provider、解析、准入、分组、证据投影、持久化、Agent 与展示分别受依赖方向和行数预算检查；干净构建先于测试。理由是重构完成不能依赖陈旧 `dist` 或旧路径偶然仍可加载，也不能让 live 验收脚本演变成不可维护的单体。

## 三轮审批复核

### 第一轮：真实 Provider 接口与搜索模式

通过。脱敏报告记录了 5 个不同的真实 BuyWhere 调用；每次都使用 `find_best_price_v2`，scope 都是 `SG`，实际参数键均为 `deliver_to`、`product_name`。观察到的显式 mode 参数集合为空，自动 fallback 为 `NONE`。

因此，高置信度结论是“当前报价 adapter 没有暴露或使用显式搜索模式”；不能进一步声称 BuyWhere 仅支持关键词搜索，也不能声称其内部支持可靠模糊纠错。明显错拼的安全行为由本地零调用门禁保证，而不是依赖 Provider 猜测。

### 第二轮：身份准入、失败语义与用户事实

通过。13 个逻辑用例全部通过：

- Sony WH-1000XM5 的真实成功观察返回 9 条原始记录，经 URL 与成色分组为 1 个 `REFURBISHED` 报价线索，原币 USD 区间为 215–249.99，并具有 HTTPS 商家页确认入口。
- Sony 配件污染和 Nintendo display-service 的真实调用在选定观察中均为 `OK_EMPTY`；这只能作为当次空结果。独立受控记录分别证明 `ACCESSORY_RECORD` / `REPLACEMENT_OR_PART_RECORD` 与 `SERVICE_RECORD` 会被硬拒绝且不发布线索。
- 明显错拼型号保持零 Provider 调用；timeout 映射为失败后用户结果 `DEGRADED`，engine degraded 保持 `DEGRADED`，circuit-open 保持控制层拒绝并发布确定性退化回复。
- Provider availability 仅留在内部 observation，公开投影的库存、配送及原始 Provider 字段计数为 0。
- 真实非 SGD 原币为 USD；系统保留原币，没有把 CNY 估算伪装成商家报价。

### 第三轮：时间可变性、隐私、工程质量与漂移

通过。当前 live 报告的 24 小时审计窗口包含 25 次历史尝试与 5 次本轮尝试；尝试状态合计为 `OK_RESULTS=3`、`OK_EMPTY=11`、`DEGRADED=2`、`FAILED=14`，最终选定的五个真实逻辑观察为 `OK_RESULTS=1`、`OK_EMPTY=4`。所有失败尝试都保留在各逻辑用例的审计历史中，没有被隐藏或改写成当前报价。

该 24 小时聚合仅用于验收，报告明确禁止把历史观察重新发布为用户当前报价。持久化数据已经脱敏：API key、原始 Provider payload 和原始商家 URL 均未写入报告，只保留聚合事实、域名、哈希与状态。

覆盖率门禁已在干净构建后通过：20 个文件、120 个测试；Statements 67.35%、Branches 57.40%、Functions 75.51%、Lines 71.85%，阈值未降低。默认 `npm run acceptance` 也已全部通过：17 个文件 / 115 个单元测试、4 个文件 / 9 个真实 PostgreSQL 集成测试、Chromium E2E 1/1，以及 58 个生产文件的单一报价 worker 与退役路径检查。

状态登记后再次运行 `npm run quote:drift:check`，结果为 phase 5 `APPROVED`、6 个阶段连续完成、目标仍为 `quote-leads-sg-v1`；审批记录与六份证据文件均存在，live report 的 13 个用例和全部 overall checks 仍为通过。

## 真实验收边界

本报告引用的脱敏机器证据是 [latest.json](../../artifacts/quote-lead-live-acceptance/latest.json)。它记录的是可变的服务观察，而不是永久产品保证。以下结论仍明确未知，且不得由 UI 或 Agent 补写：

- BuyWhere 内部究竟采用关键词、模糊、语义或其他检索算法；
- 任何型号在未来时刻是否仍会返回相同数量、商家、价格或币种；
- 商家页当前库存、最终价格、版本/颜色一致性、配送和结账可用性；
- “全网最低”“最佳选择”或完整市场覆盖。

## 可复现门禁

- `npm run quote:contract:check`
- `npm run quote:drift:check`
- `npm run quote:live:acceptance`（需要显式只读授权）
- `npm run acceptance`

上述阶段门禁、状态登记和审批后漂移检查均已成功，阶段 5 完成。
