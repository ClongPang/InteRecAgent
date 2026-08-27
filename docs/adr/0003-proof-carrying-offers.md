# ADR-0003：以携带证明的报价替代负向过滤

- 状态：Accepted
- 日期：2026-08-26
- 替代：扁平 `OfferObservation`、标题配件黑名单、模型 `submit_decision` 和 `decision.fallback`

## 背景

旧主链路把 BuyWhere 搜索结果直接归一化为可排序报价。只要结果没有命中已知的型号、配件、预算或库存排除规则，就默认进入排序。真实 run 证明这种“默认接纳、已知错误再排除”的策略会把检索市场、Provider 国家字段和 BuyWhere 跳转地址错误提升为商户及市场事实。

商品目录是开放世界，任何基于历史 bad case 扩展的负向规则都不可能完备。错误不在某个关键词，而在事实晋级模型。

## 决策

采用正向证据准入和类型状态流水线：

```text
RawArtifact
  -> DiscoveredListing
  -> ProductIdentity
  -> QualificationResult
  -> ComparableOffer
  -> ComparisonSet
  -> ValidatedDecision
```

只有 `ComparableOffer` 能进入排序。`DiscoveredListing` 在类型上不能传给决策内核。

每个事实使用 `Fact<T>`，包含值、状态和 `EvidenceRef[]`。市场语义明确拆分为：

- `retrievalMarket`：发给 Provider 的检索参数；
- `providerCountry`：Provider 返回的观察值；
- `targetDomainCountry`：从真实目标站点 ccTLD 取得的有限证据，不等同于商户所在地；
- `MarketEvidence.level`：`TARGET_DOMAIN_MARKET_CONSISTENT / PROVIDER_ATTESTED / UNVERIFIED / CONFLICTED`。

`PROVIDER_ATTESTED` 只允许描述为 Provider 市场归类，不代表销售地或配送资格。`UNVERIFIED` 和 `CONFLICTED` 均不能晋级。

商品身份使用类别、规范型号、`itemRole` 和 condition 组成 comparison key。系统比较同一 comparison key；不同本体/配件、型号或 condition 不进入同一个 ComparisonSet。

BuyWhere 定位为 Discovery Source。它提供原始价格、标题和候选链接，但不自动获得配送或最终购买资格的证明权限。后续 Verification Source 必须通过相同的 evidence contract 接入。

## Agent 边界

pi-agent 负责：

- 从受控 ConversationSnapshot 理解本轮开放语言；
- 通过 `commit_turn_plan` 提交有序、多操作 TurnPlan；
- 根据宿主返回的 evidence gap 决定是否研究，并通过 `publish_reply` 组织最终回复。

宿主负责：

- 事实提取和状态晋级；
- ComparisonSet 构造与排序；
- 可选 Decision、AssistantMessage 与 durable Turn 原子提交。

模型不能直接提交或改写事实性 Decision。澄清、解释和本地比较等 Turn 可以没有 Decision；宿主只从已晋级的证据生成可选 Decision。

## 持久化

新增：

- `source_listings`
- `offer_qualifications`
- `comparison_sets`
- `comparison_set_items`
- `decisions.comparison_set_id`

原始 artifact 保持不可变；失败晋级的 listing 和 reason codes 继续进入审计账本，但不会进入 ComparisonSet。

## 不变量

1. 没有完整证据的 listing 不能成为主推荐。
2. 加入更便宜但未验证的 listing，主推荐不得变化。
3. 市场事实冲突必须 fail closed。
4. item role、规范型号或 condition 不同的结果不得混入同一 ComparisonSet。
5. 输入排列变化不能改变确定性 Decision。
6. 所有输出事实必须回溯到 EvidenceRef。
7. Provider schema 新增字段不能自动获得决策权限。
8. 展示的目标商户 URL 与 BuyWhere attribution URL 的嵌套目标必须完全一致。

## 后果

该决策会主动降低召回率：缺少市场或商品身份证据时返回 `NO_MATCH`，而不是输出看似有用但无法证明的低价。提升召回率必须通过新的事实源、类别 contract 或更强的可验证证据完成，不能通过放宽准入或添加例外实现。
