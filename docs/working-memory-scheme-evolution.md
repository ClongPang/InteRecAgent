# 工作记忆：问题与方案变迁

**版本**：1.1  
**日期**：2026-08-20  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：问题复盘 + 方案取舍  
**范围**：流式硬化之后的「上下文怎么压缩」。记录为什么不做摘要器、DST 怎么投影、直播里身份/路由/指代又破了哪一层。话轮如何分叉、有模型时是不是聊天历史，见 [dialogue-route-scheme-evolution.md](./dialogue-route-scheme-evolution.md)。

本文接 [live-hardening-scheme-evolution.md](./live-hardening-scheme-evolution.md)。那里收束了传输、grounding 第一刀、snapshot 级否定和品类相关性。这里收束的是**任务记忆如何进模型、如何进过滤、如何在 BuyWhere 换 ID 后仍对齐**。事实层 / 决策层 / 语言层的职责分离不变：LLM 可以漏槽或误分类，确定性代码纠偏；不得编造价格、库存、保修。

---

## 1. 变迁总览

上下文爆炸不是「字数太多」一个问题。它同时是推荐产品问题和对话产品问题：模型看不见用途、看不见比较集、看不见否定原因，就会空搜、指错对象、把 FHD 或音箱当首选。

```text
阶段 0  硬截断 DST
        只留最近 3 条用户原话
        分类 dump 全量 belief
        起草吞掉全部 ranked
        use_case 字段存在但从未写入
            │
            ▼
阶段 1  方案选型（PM + 架构）
        否决：会话摘要器 / 长期画像 / LLM 重排当事实
        选定：一份 DST，三角色视图
            │
            ▼
阶段 2  投影落地
        Critique.reason / SpecGate / use_case
        model_context：TurnView · CatalogStats · draft_candidates
        规格门闩进过滤 / 打分 / 检索
            │
            ▼
阶段 3  直播验收打穿
        否定后同款换 source_id 回来
        REJECT 只 rerank 不硬丢
        模型 STANCE 漏 stance、「只看有货」收成问库存
        「Hiking」音箱混进徒步鞋
        白色那个掉出比较集后回落到全局第一件
```

| 阶段 | 用户能看见的失败 | 根因层级 | 最终落点 |
|---|---|---|---|
| 0 | 「适合远程办公」被剥掉；对比后指代乱；否定只剩「不要了」 | 记忆投影 | 一份 DST + 角色视图 |
| 2 | 4K 问出来 FHD；研究循环因 sample 难看而空搜 | 硬约束与工具回传 | `SpecGate` + `CatalogStats` |
| 3 | 排除后又推同款；太贵了没记账；音箱当徒步鞋 | 身份、路由、grounding、相关性 AND | page/title key、REJECT→refilter、stance/库存纠偏、鞋靴形态 |

---

## 2. 为什么不做会话摘要器

压缩上下文时，最容易想到的是「再加一个 LLM 把历史收成一段话」。这一轮明确否决。

| 方案 | 主张 | 否决 / 选用原因 |
|---|---|---|
| 会话摘要器 | 任意长度历史都能塞进窗口 | 摘要会丢指代锚点（「白色那个」）、比较集、否定对象；再引入一轮不可复现的模型写事实 |
| 长期用户画像 | 跨任务记住「喜欢便宜」 | 本产品是单次选购任务，不是会员中心；态度必须挂在**这件 listing** 上 |
| LLM 重排当真相 | 模型看完全量再挑 | 与「证据可追溯、persist 唯一写库」冲突；模型只能起草，ID 仍须落在候选里 |
| 只截断最近 N 轮用户原话 | 实现便宜 | 没有助手邻接对，指示语无法解；`use_case` 从未写入，标题里的「适合…的」被剥进 query 废料 |
| **一份 DST + 三角色视图** | 权威状态仍是 Mission；模型只收投影 | 分类、研究、起草各看自己该看的槽，不 dump listing key / 全量目录 |

选型约束（后来没破）：

- 不改 LangGraph 外层边：`classify → effects → merge → route → … → persist`
- persist 仍是唯一写库
- 不把研究沙箱的后端控环改成「让模型自己翻历史」或自由点工具

---

## 3. 一份 DST，三个视图

权威状态始终是 `ShoppingMission`（约束 + `PreferenceBelief` + `DialogueState` + `comparison_snapshot_ids`）。新增的不是第二份记忆，而是**只读投影**。

```text
                    ShoppingMission
                   （唯一事实源）
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
     TurnView        CatalogStats    draft_candidates
     分类器窗口        研究工具回传      起草切片
     邻接对+DST        计数/价格/命中    主推+两备选+比较集
     比较集+前三       簇样本，无全量     不吞全部 ranked
```

设计上对应三个模式：

- **投影（View）**：`model_context.py` 是唯一投影层。分类、LLM `parse_turn`、研究循环、起草都从这里取窗口，禁止各节点私自 `belief.model_dump()`。
- **单一事实源**：`apply_act_effects` 仍是信念副作用的唯一入口（否定、态度、不支持维度）。命令层预览与图节点共用，避免两条路径漂移。
- **空集回退**：规格门闩、品类相关性都遵守「会清空则原样返回」。没有结构化规格时，不假装筛过。

### 3.1 分类窗口：`TurnView`

**旧方案**：`build_turn_context` 截最近 3 条**用户**原话，并把 belief 整包塞给 `parse_turn`。listing key、全量 critiques、asked/skipped 槽都进模型。

**新方案**：邻接对（最后一条用户 + 最后一条助手）+ `belief.dst_summary()` + 比较集 brief + ranked 前三。

这不是把对话线程当 chat messages。`parse_turn` 是**单次 JSON 完成**：系统提示 + 一条 user（当前句 + 上述投影）。全程 transcript 不进模型。研究循环里的多轮 `messages` 只属于当趟工具轨迹，也看不见用户历史。分叉规则见 [dialogue-route-scheme-evolution.md](./dialogue-route-scheme-evolution.md)。

`dst_summary()` 只露：

- `use_case`、`spec_gates`（属性名）、`price_sensitivity`
- `pending_slot`、`last_reject_reason`、`rejected_count`

不露 `rejected_listing_keys`。模型需要知道「已经排除过、原因是太贵」，不需要知道 BuyWhere 的 click URL。

关键文件：`backend/application/services/model_context.py`、`nlu.py` `build_turn_context`、`infrastructure/llm/openai_compat.py` `parse_turn`。

### 3.2 研究窗口：`CatalogStats`

**旧方案**：工具回传前 5 条 title brief。样本难看时，研究者会再搜一次，即使目录里已经有足够 4K 显示器。这是规划盲视，不是召回不足。

**新方案**：停搜由池子件数和环境阈值决定，不再因为 sample 难看就重搜。keep / TopK 只看 ID + brief。

关键文件：`backend/agent/tools/catalog.py`、`backend/agent/loop.py`、`backend/agent/judges.py`。

### 3.3 起草窗口：`draft_candidates`

**旧方案**：`draft_recommendation` 吃全部 ranked。窗口被目录撑满后，比较集和第三备选被挤掉。

**新方案**：主推 + 两件备选 + 当前 `comparison_snapshot_ids`。比较集里的白色款即使不在前三，起草仍看得到。

关键文件：`backend/agent/nodes/evidence.py`。

---

## 4. 槽位怎么从「字段空着」变成可执行约束

### 4.1 `use_case`：用途不是检索词

**旧方案**：`PreferenceBelief.use_case` 已在 DTO 里，解析器从不写。`适合远程办公的 27 寸 4K 显示器` 经 `_strip_known_slots` 变成 `27 寸 4K 显示器`，用途蒸发。检索和排序都不知道「远程办公」。

**新方案**：

| 层 | 行为 |
|---|---|
| 解析 | `extract_use_case`：`适合X的` → `X`；`送给Y的` → `送给Y`。赠礼前缀同时从 query 剥掉 |
| 合并 | `belief.with_use_case`；`ground_dialogue_act` 补模型漏抽 |
| 检索 | `plan_search` 在 query 尚未包含该短语时追加，显示用 query 仍保持短 |
| 简报 | 芯片「用途 远程办公 / 送给爸爸」 |

直播里 DeepSeek 有时会把 `27寸 4K 显示器 远程办公` 写回 query。grounding 只在 patch.query 为空时补，**不覆盖模型已写出的 query**。这是有意的：宁可检索词稍长，也不和模型抢已经抽对的品类。简报上的「用途」芯片仍以 belief 为准。

### 4.2 `SpecGate`：标题可判定的规格，不是伪结构化属性

BuyWhere 没有可靠的分辨率字段。4K 只能靠标题 cues。

| 方案 | 主张 | 取舍 |
|---|---|---|
| 假装有 `structured_specs.resolution` | 过滤好写 | 字段经常空，会假空集或假命中 |
| 只把 4K 写进 query | 实现最小 | 排序仍可能把更便宜的 FHD 抬到首选 |
| **required 门闩 + 空集回退** | 标题全 AND 命中才留；会清空则不筛 | 承认这是弱规格，不编造 |

当前门闩：

- `4k` required：`4k` / `2160` / `uhd` / `3840`
- `27inch` optional：只加分，不清空
- `overear` / `inear` required：形态词，可用「不要头戴 / 不要入耳」关掉

过滤在 `apply_spec_gates`；打分在 `score_and_rank` 用同一套 cues 加权。27 寸是软偏好，4K 是硬门闩——直播里「只要 4k」芯片对应 required。

### 4.3 `Critique.reason`：否定原因挂回那一件

**旧方案（硬化文档阶段 C）**：否定记下 listing key，态度另开一条 `price_stance`。用户路径是「不要这款 → 太贵了」，原因和对象是两张皮。Probe 会反复问「为什么不要」，即使刚说完太贵。

**新方案**：

```text
REJECT  →  belief.reject(..., reason=unknown|form|brand)
STANCE  →  annotate_last_reject(PRICE) 再 mark_price_stance
Probe   →  last_reject_reason 已不是 unknown 则不再问 REJECT_REASON
```

`annotate_last_reject` 从后往前找最近一条 `reject_item`，只改 `reason`，不另开无对象批评。简报在 `reason == price` 时出「排除原因：太贵」，与「觉得偏贵」并存：前者绑 listing，后者是全局价格态度。

---

## 5. 直播里被打穿的四层

阶段 2 的单元测试是绿的。BuyWhere + DeepSeek 的真实话轮又打穿了身份、路由、grounding、相关性。每一层都先用过「看起来够用」的方案。

### 5.1 否定身份：snapshot → source_id → 商户页

硬化文档已经要求「否定对象是 listing，不是 snapshot」。当时的 key 是：

```text
snap:{uuid} | src:{source_product_id} | url:{click_url} | title:{norm}|m:{merchant}
```

直播反例：同一条 Quadrastores 的 Samsung 27" 4K，

| 轮次 | source_product_id | merchant slug |
|---|---|---|
| 被否 | `473734239` | `shopify_buy30620_stock` |
| 回流 | `564527982` | `shopify` |

title+merchant 对不上，click URL 里的 `product_id` 也换了。肉眼是同一 PDP。

**换法**：从 BuyWhere click 包装里解开内层商户 URL，得到 `page:quadrastores.com/products/samsung-27-inch-...`；同时保留不带商家的 `title:{norm}`。`expand_listing_keys` 让**旧批评**里已经存下来的 `url:` / `title:…|m:` 在过滤时也能对齐到新键，不必迁移库。

仍不选「品牌+尺寸」粗粒度：排除一件 Samsung 不应误伤另一条不同 PDP。

关键文件：`backend/application/services/rec/identity.py`、`pipeline.py` `run_filter` / `run_rank`。

### 5.2 REJECT 路由：rerank → refilter

**旧方案**：有缓存的否定走 `RERANK`，意图是「不要重搜」。`RERANK` 边是 `load_cache → rank`，**跳过** `filter_hard_constraints`。`run_rank` 只把命中的 listing 沉底，不删除。同款换 ID 后若 key 对不上，最便宜的那件仍是首选——这就是验收时「排除了还在推 Samsung」的直接原因。

**新方案**：有缓存的 `REJECT` 走 `REFILTER`（`load_cache → filter → rank`）。listing key 硬丢；规格门闩一并生效。`STANCE` 仍走 `RERANK`：态度改排序权重，不丢候选。

评测 JSON 同步改了 `06-reject-this` / `07-reject-brand` / `29-reject-this-one` 的期望路由。这是产品语义变化，不是测试迁就实现。

### 5.3 grounding 第二刀不够

硬化文档的 `ground_dialogue_act` 只在模型返回 `refine` / `unknown` 时改回言语行为。直播里模型已经「说对了 kind、漏了槽」：

| 用户 | 模型 | 旧后果 | 新纠偏 |
|---|---|---|---|
| 太贵了 | `express_stance` 且 `stance=null` | `last_act` 已是态度，belief 没 annotate | STANCE 缺 stance 时用确定性补 |
| 只看有货 | `ask_about_item` / stock | 走 talk，库存开关不进约束 | ASK_ITEM 若确定性是带 `only_in_stock` 的 refine，改回 refine |

原则没变：**成功响应里的漏抽比抛错更常见**。只是纠偏要从「kind 错了」扩到「kind 对、槽空了 / kind 被问句模板吸走」。

### 5.4 品类相关性：任一线索 → 形态 AND

硬化文档的品类门闩用「标题命中任一 cue」。`徒步鞋` 的 cues 是 `hiking / trek / 徒步 / trail`。音箱标题末尾写着 `Suitable for … Hiking`，短裤写着 `Hiking Shorts`，都过门。直播首选变成 ¥61 的蓝牙音箱。

**换法**：`徒步鞋 / 登山鞋` 必须同时命中「徒步语义」和「鞋靴形态」（`shoe / boot / 鞋 / 靴`…）。空集仍回退。显示器 / 耳机保持单组 ANY，因为那些 cue 本身已经是品类词。

这与 `SpecGate` 不同：规格门闩是用户说出口的 4K；这里是 query 品类的最低形态约束。两者都在 `run_filter` 里顺序执行：先品类，再规格，再排除词，再预算。

### 5.5 比较集指代

**旧方案**：`resolve_referent_ids` 在比较集里找品牌 / 最便宜 / 焦点。没有颜色。「白色那个」在比较集未命中后，`compose_talk_reply` 回落到全局 rank 1。若第一件碰巧在比较集里，看起来像对了；若第一件是集外的 LG 白，就会指飞。

**新方案**：

1. 颜色进入 `detect_referent_hint`（`白色那个` / `那个黑色`）
2. 解析池优先 `comparison_records`
3. 有比较集且本次是带 hint 的指代、但集内未命中 → 返回空，文案「当前候选里找不到你指的那一件」

不在这时去全局目录里「智能补一个白色」。比较集是用户刚确认的工作集。

---

## 6. 数据怎么流过一轮话

```text
用户原文
    │
    ├─ parse_intent / classify_turn     确定性：query / use_case / gates / 言语行为
    ├─ parse_turn (LLM)                 开放 soft_prefs；可能漏槽、错 kind
    └─ ground_dialogue_act              kind / stance / 库存 / 品类补洞
                │
                ▼
        apply_act_effects               否定、态度、原因 annotate
                │
                ▼
        merge_mission_state             约束 ∪ use_case ∪ spec_gates
                │
                ▼
        route_turn                      五选一，不是整图都跑
           clarify  → persist
           talk     → 读缓存 → grounded 回复 → persist
           rerank   → 读缓存 → 排序 → 校验 → 起草 → persist
           refilter → 读缓存 → 过滤 → 排序 → 校验 → 起草 → persist
           research → 检索/规则/keep/累加 → TopK → 校验 → 起草 → persist
```

`plan_route` 按 kind + 缓存 + 复用键（query/市场/预算）顺序命中。问和比走 talk；态度 rerank；排除和软过滤 refilter；换品类或改预算才 research。完整判定表见 [dialogue-route-scheme-evolution.md](./dialogue-route-scheme-evolution.md)。

前端 `BeliefBar` 只展示投影：用途、只要/偏好门闩、排除原因、价格态度。不展示 listing key。

---

## 7. 直播对照（本轮）

| 话轮 | 阶段 0 / 旧实现 | 修复后实况 |
|---|---|---|
| 适合远程办公的 27 寸 4K 显示器，3000 元以内 | 用途丢、可能出 FHD / 血压本 | 芯片「用途 远程办公 / 只要 4k」；首选 27" 4K（Samsung / AOC），约 ¥605 起 |
| 不要这款 | 换 snapshot 或换 BuyWhere id 后同款回来 | page/title 对齐后同款硬丢；简报「已排除 1 件」 |
| 太贵了 | kind 已是 STANCE 但原因/态度没写上 | `Critique.reason=price` +「觉得偏贵 / 排除原因：太贵」 |
| 帮我比前两个 → 黑色那个 | 可能落到全局第一件 | 留在比较集 AOC；白色未命中则说找不到，不跳到集外 LG |
| 送给爸爸的轻便徒步鞋，1000 元以内 | query 带「送给爸爸」或用途空；首选音箱 | 芯片「用途 送给爸爸」；重过滤后当前推荐 Quechua 徒步靴，不是音箱 |

线程里仍可能留着第一轮误推音箱的**历史气泡**。那是当时 persist 的 `agent.message`，不是当前 `recommendation`。投影期不改写历史事件。

---

## 8. 文件对照（按变迁）

| 变迁 | 新增 | 主要改动 |
|---|---|---|
| 投影层 | `backend/application/services/model_context.py`、`tests/test_model_context.py` | `nlu.build_turn_context`、`openai_compat.parse_turn`、`judges.py`、`evidence.compose`、`catalog` 工具回传 |
| DST 槽 | — | `dto/belief.py`（`RejectReason` / `SpecGate` / `Critique.reason`）、`dto/runner.py` `IntentPatch`、`parse_intent.py`、`policy.py`、`decide.py` |
| 规格与检索 | — | `domain/policies/filter_rank.py` `apply_spec_gates`、`score.py`、`rec/state.py`、`retrieve.py`、`pipeline.py` |
| 否定身份 | — | `rec/identity.py` `page_key` / `expand_listing_keys` |
| 路由 | — | `route.py` REJECT→refilter；`tests/eval/dialogues.json` |
| 指代 | — | `nlu.py` 颜色 hint；`grounded.py` 比较集未命中不回落 |
| grounding 扩面 | — | `nlu.ground_dialogue_act`：补 stance、纠「只看有货」 |
| 徒步形态 AND | — | `filter_rank.py` `_CATEGORY_CUES` 第三组 form cues |
| 简报 | — | `frontend/src/api/types.ts`、`MissionBrief.tsx` |

测试主要加在 `tests/test_model_context.py`、`tests/test_dialogue.py`、`tests/test_rec.py`、`tests/test_filter_rank.py`、`tests/test_uncertainty.py`、`tests/eval/dialogues.json`。

---

## 9. 以后不要退回去的几条

1. **权威状态是 Mission，模型只收视图。** 不要为了「让模型看全一点」把 listing key、全量 ranked 或 thread transcript dump 回 `parse_turn`。  
2. **不要加会话摘要器来解决指代。** 比较集和邻接对是结构化工作集，不是一段散文能代替的。分类保持单次 JSON，不要改成多轮 chat。  
3. **否定对象是商户 PDP，不是 BuyWhere product_id。** click 包装和商家 slug 都会变；用解开后的 `page:` 和纯标题对齐，旧 key 要能 expand。  
4. **排除是过滤，态度是重排。** REJECT 有缓存必须 refilter；STANCE 才 rerank。不要为了省一次 filter 让被否款靠价格再赢回来。  
5. **kind 对不等于槽写上了。** grounding 要补空 stance，也要把「只看有货」从问句模板里抢回来。  
6. **品类 cue 的「Hiking」不是鞋。** 探索召回默认脏；形态约束与规格门闩是两层，都遵守空集回退。  
7. **比较集是封闭工作集。** 集内找不到的颜色 / 品牌，不要回落到全局第一件。

这七条是本轮方案变迁收束后的约束。下一轮若要动记忆、检索身份或过滤，先对照这里的失败案例，并回看 [live-hardening-scheme-evolution.md](./live-hardening-scheme-evolution.md) 里尚未失效的六条。

商户跳转 403、工作台视觉层次，以及旧任务商品图读路径回填，见 [workspace-surface-scheme-evolution.md](./workspace-surface-scheme-evolution.md)。研究工具签名（软决策带参、硬步骤无参）见 [research-tool-use-scheme-evolution.md](./research-tool-use-scheme-evolution.md)。话轮分叉与模型窗口（单次 JSON，不是聊天历史）见 [dialogue-route-scheme-evolution.md](./dialogue-route-scheme-evolution.md)。
