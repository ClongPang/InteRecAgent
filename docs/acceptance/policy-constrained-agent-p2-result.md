# P2 验收：ESCI 查询—商品相关性与候选准入

- 日期：2026-08-31
- 阶段：`P2_ESCI_CANDIDATE_ADMISSION`
- 策略版本：`esci-admission-v2`
- 结论：通过

## 本轮发现的根因

真实 Buywhere 结果暴露了证据循环：标题中的 `Headphone` 先被规则派生为 `headphones / PRIMARY_PRODUCT`，相关性策略又把这两个同源派生值当成独立事实，将耳机放大器错误判为 `EXACT`。供应商只提供宽泛的 `electronics` 分类，无法单独证明商品类型。

同时，旧配置把“头戴式耳机”当作 generic `headphones` 的同义词，丢失了用户短语对形态的收窄语义，使骨传导/开放耳结果可能进入主候选。

## 采用的方案

- 细粒度供应商分类可作为独立品类证据；仅由标题派生的品类与角色不得互相作证。
- 宽泛目录或具体 `targetText` 需要一次批量语义裁决；模型失败、缺失、低置信度或规则冲突时一律 fail closed。
- `targetText` 保留对品类的形态、模态、子类型等收窄语义；同大类但不满足具体目标的商品不得进入主推荐。
- 模型只提供 `SemanticRelevanceSignal`；确定性 ESCI 策略仍持有准入和 cohort 映射权。
- 只有 `EXACT` 可以进入 `MAIN_RECOMMENDATION`；其他标签保留审计语义但不能进入主排序。

## 否决的方案

1. 增加 `amplifier`、骨传导等标题黑名单：不可扩展，会继续堆叠 badcase。
2. 继续信任标题 token：不能识别目标词作为另一类商品修饰语的情况。
3. 只信 Buywhere taxonomy：真实 SG 数据只有 `electronics`，会误杀正常耳机。
4. 让模型直接排序或直接写 WorkingSet：会绕过确定性准入和证据审计。

## 验收证据

- 23 个 ESCI 用例，覆盖 5 个品类和全部五类标签。
- 领域层覆盖：独立目录证据、标题派生证据、具体目标短语、低置信度和结构化/语义冲突。
- 运行时覆盖：正常主商品进入 MAIN，关联商品进入 RELATED 或非主 cohort。
- 真实模型 `deepseek-v4-flash` 的语义信号、置信度和 reason code 写入 qualification 账本。
- 真实 Fosi K7 耳机放大器为 `IRRELEVANT / INELIGIBLE`，未进入 WorkingSet。
- `npm run architecture:p2:check`、类型检查、定向测试、全量 acceptance 与 PostgreSQL 集成测试通过。

## 目标漂移检查

- 未增加商品标题黑名单或品类专用控制分支。
- 未削弱 pi-agent 的自然语言业务规划权。
- 未让语义模型获得硬准入、排序或状态写入权限。
- 修复仍位于固定 P0→P5 顺序中的 P2 候选准入不变量。
