# 工作集 · 话轮计划 · 对话策略

**版本**：1.0  
**日期**：2026-08-21  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：开发 / 测试 / 验收  
**范围**：把工作单元从「一句一个 act、一条路由、一份 TopK」换成「一轮一个小计划、一个可绑定的工作集、一个可计算的对话策略」。外层五路分叉与 grounded 回复不推翻。

本文落实此前架构结论：句式绑定、指代、soft_prefs 可缝；`DialogueAct` 当一轮、`ranked` 当世界、`kind + N/R/K` 当策略必须拆。

---

## 0. 不变量

重构时不得破坏：

1. 检索不是每句默认路径。`talk / clarify / refilter / rerank / research` 五边保留。
2. 目录归工具。模型不得编造商品、价格、库存、汇率，不得改硬预算。
3. 用户可见文本只渲染运算结果，模型不写导购长文。
4. 检索复用键只含 `query / markets / budget_cny`。商户过滤不进复用键。
5. 运算种类封闭；平台名、品牌、品类不建词表。针对着工作集绑定。
6. 问句必须能兑现。直邮、保修、评分不可问。
7. 研究环由后端推进，不退回自由 ReAct。

---

## 1. 目标对象

```text
用户句
  → TurnPlan          有序 op，可多个；做不完写入 leftover
  → WorkingSet.bind   pool ∪ mentioned ∪ display
  → ConversationPolicy  问 / 谈 / 滤 / 搜 / 收束
  → 执行一条图边（或先谈再留下一步）
  → 回复合成全部已执行 OpResult
```

| 对象 | 取代什么 | 不取代什么 |
|---|---|---|
| `WorkingSet` | 把 `ranked` 当成唯一世界 | 对外仍只展示 `display` |
| `TurnPlan` | 单枚举 `DialogueAct.kind` 当一轮 | 单个 op 仍可投影成 `DialogueAct` 以兼容旧测试 |
| `ConversationPolicy` | `kind → 边` 与 `pool≥25 / 搜满 3 次` 停搜 | 五条图边本身 |

---

## 2. 阶段一：WorkingSet

### 2.1 行为

`candidate_sets.payload` 增加 `pool`。缺失时 `pool = ranked`（旧缓存兼容）。

```text
WorkingSet
  pool        本任务仍有效的候选（研究累加池的持久化）
  display     当前决策集（原 ranked，K 是上限）
  mentioned   本场指过且仍在 pool 里的记录
  views       merchants / markets / forms / price_span   ← 算出来的
```

绑定、集合询问、指代对着 `pool ∪ mentioned ∪ display`。  
回复引用 `display` 或本轮 probe 命中。  
绑定失败必须说「当前列表对不上『X』」，不得默默顶第 1 件。

### 2.2 开发

| 项 | 落点 |
|---|---|
| `WorkingSet.from_cache` | `backend/application/services/working_set.py` |
| `World` 从工作集取绑定宇宙 | `world.py` / `nlu.resolve_referent_ids` |
| 研究结束写入 `pool` | `research` 节点返回 `ctx.pool`；`persist` 为池内商品建快照并写入 payload |
| 再过滤保留旧池 | persist 在 `reuse_snapshots` 时拷贝已有 `pool` |
| 指代封闭结构 | 第 3 个、最后那个；`referent_ranks` |
| TurnView | `set_merchants` 来自 pool，模型仍只看 display 预览 |

### 2.3 测试

- 旧 payload 无 `pool`：绑定宇宙 = `ranked`。
- 新 payload：`pool` 含未进 TopK 的一件，用户指其 title token，必须命中，不得落到 display[0]。
- 「那个索尼」在 pool 标题含「索尼」、display 不含时，命中 pool 件。
- 绑定失败：「白色那个」在比较集与 pool 皆无白，回复含「找不到」或「对不上」，`snapshot_ids` 为空。
- 「第三个」在 3 件 display 上解析为 rank 3。
- persist 往返：研究后读回的 cache 含 `pool`，且 `len(pool) >= len(ranked)`。

### 2.4 验收

- 用户问「刚才那款 Shopify」，该款在池不在 TopK → 能指到或明确说已不在当前决策集，不顶焦点款。
- 无回归：`有lazada平台的吗` 仍只读集合；`只要美国` 仍是市场。

---

## 3. 阶段二：TurnPlan

### 3.1 行为

一句可抽出多个独立 op，先到先得只用于**互斥**结构（撤销、元能力），不用于「询问 + 比较」。

```text
TurnPlan
  ops:       [WorldOp, ...]     已从本句抽出、按执行序
  leftover:  [WorldOp, ...]     本轮图边做不完的，写入 DialogueState.pending_ops
  primary:   DialogueAct        兼容投影：路由与旧评测看它
```

独立抽取（可并存）：

- `probe_set`：有…吗（库存封闭词除外）
- `compare`：帮我比 / 对比
- `reject` / `stance` / `filter` / `ask_item` / `refine`

条件句「没有就只要美国」**不**在本阶段自动执行后半句，只变成 next_move / leftover，避免空集条件被当成已承诺约束。

### 3.2 执行与回复

| 计划形态 | 图边 | 回复 |
|---|---|---|
| 仅 talk op（probe / compare / ask / meta） | `talk` | 按序渲染全部 OpResult，段落拼接 |
| talk + refilter（只要 lazada 且比一下） | `refilter` | 本轮过滤；compare 进 leftover 与 next_moves |
| talk + research（换品类） | `research` | 研究完成后走推荐稿；未执行 talk 进 leftover |
| 仅 refine / reject / stance | 与现行 `plan_route` 一致 | 不变 |

`classify_turn` 返回 `primary`，保证 `tests/eval/dialogues.json` 的 kind/route 不断。  
`compose_talk_reply` 增加计划入口；单 act 仍可用。

### 3.3 开发

| 项 | 落点 |
|---|---|
| `WorldOp` / `TurnPlan` | `application/dto/dialogue.py` |
| `propose_plan` | `application/services/plan.py`；`frames` 提供可叠加抽取 |
| `DialogueState.pending_ops` | `mission.py` |
| 分类节点写入 `turn_plan` | `nodes/dialogue.py` |
| 合成多结果 | `grounded.py` |

模型路径：`parse_turn` 仍可出单 act；`propose_plan` 补齐句式抽出的并列 op。模型 kind 与句式冲突时，**句式话轮行为优先，封闭槽（预算/市场）仍可补**。

### 3.4 测试

- 「有 lazada 吗，帮我比前两个」→ ops 含 `ask_about_set` 与 `compare_items`，route=`talk`，回复同时提到集合结论与对照。
- 「有 tokopedia 吗」单独仍只有 probe，无代码表。
- 「帮我比前两个」仍只 compare，kind/route 与 eval 一致。
- leftover：只要 lazada + 比一下 → route refilter，`pending_ops` 含 compare 或 next_moves 含对比。
- 旧 eval 全绿。

### 3.5 验收

- 一句多意图不再只做第一件。至少覆盖「集合询问 + 比较」。
- 用户仍看到 grounded 短句，不是模型散文。

---

## 4. 阶段三：ConversationPolicy 与决策集

### 4.1 决策集质量（计算，不是提示词）

对一组记录计算：

```text
axes = 形态可分 + 商户可分 + 市场可分 + 价差≥400
discriminable ⇔ n≥2 且 axes≥2
```

K 是 **display 上限**，不是凑满目标。可分辨且只有 3 件时，展示 3 件，不拿同质 Shopify 补到 6。

### 4.2 研究环停搜

改环境契约（`ResearchLimits` + `run_research`）：

```text
停搜当且仅当：
  已搜满 max_searches
  或 pool 达 pool_threshold（上限，防爆）
  或 （pool 可分辨 且 至少 2 件 且 已完成至少 1 次检索）
无法改写则停。
keep 失败：本轮不并入（已落地），不得整批灌回。
```

`pool_threshold` 仍默认 25，语义改为上限。  
`top_k` 仍默认 6，语义改为上限。  
终选：优先覆盖不同形态/商户/市场的决策集，再按分排序截断。

### 4.3 对话策略

`ConversationPolicy.decide` 包在现行 `plan_route` 外，只追加可计算规则：

1. 商户过滤对 **pool** 求值，空集才升 research（不再只看 display）。
2. 绑定失败的 ask/probe → `talk`（空结果合法）。
3. 决策集不可分辨且本轮是「同检索键的 refine、无新过滤」→ 保持 research（需要新召回）或 talk+probe（已有集合但不可比时，问一句能切开的兑现槽，沿用 `uncertainty.select_probe`）。
4. 不把 `plan_route` 堆成超长 kind 分支。

### 4.4 测试

- 两件同商户同市场同形态、价差 <400：`discriminable` 为假；研究环在 `max_searches` 内应尝试改写，不得因「已经有 2 件」停。
- 两件形态不同且市场不同：`discriminable` 为真；一次检索后可停，display ≤6 且不强制补满。
- 商户针只在 pool、不在 display：只要 lazada **不**升 research，走 refilter。
- keep JSON 失败：pool 不增长（已有测试保留）。
- eval `23-us-market`：只要美国 → 市场 US，不是商户。

### 4.5 验收

- 脏召回不再靠「凑满 6 / 堆到 25」结束。
- 空集平台问题仍诚实；可比集合能提前停搜。
- 离线 `pytest -m "not integration and not live"` 全绿。

---

## 5. 明确不做

- 平台/品牌/品类/态度/形态词表扩写。
- 模型写用户可见推荐长文。
- 自由 ReAct 控检索。
- 自动执行「没有就…」后半句改约束。
- 保修/直邮编造。

---

## 6. 执行顺序

1. WorkingSet 持久化与绑定宇宙（阶段一）——后续计划必须绑在正确世界上。  
2. TurnPlan 抽取与 talk 多结果合成（阶段二）——策略才有「还欠什么」。  
3. 决策集停搜 + Policy 包一层（阶段三）。  
4. 离线测试与验收用例。

每阶段可单独合并语义，但必须按此依赖，不得只改停搜数字或只加句式。
