# 联调硬化：问题与方案变迁

**版本**：1.0  
**日期**：2026-08-20  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：问题复盘 + 方案取舍  
**范围**：流式事件落地之后的真实联调。记录「当时为什么那样写、线上哪里破了、换了哪套、为什么不选另一套」。

本文不替代 [technical-architecture-and-selection.md](./technical-architecture-and-selection.md) 的总体选型，只补**运行时硬化**这一截。事实层、决策层、语言层的职责分离仍然成立：LLM 可以漏抽或误分类，确定性代码负责纠偏，不得编造价格、库存、保修。

---

## 1. 变迁总览

联调不是一次改完。同一类问题往往先用「看起来够用」的方案，被真实话轮打穿后再下沉一层。

```text
阶段 A  流式骨架
        REST 命令 + SSE 事件 / 文本流
        写后通知，事件表为真
            │
            ▼
阶段 B  首轮联调（通勤降噪耳机）
        模型漏抽品类 → 空追问
        忙时 SSE 重连 + after=0 回放 → GET 风暴
        推荐查询在无 run 时 404
            │
            ▼
阶段 C  第二轮联调（对比 / 否定 / 压预算 / 换品类 / 连点）
        否定只记 snapshot_id → 重搜后失效
        recommendation.ready 与 agent.message 双写 → 线程重复
        模型把「太贵了」收成 refine → 态度丢了
        最低价排序吃进无关召回 → 显示器推出血压本
        首页 isPending 挡不住同 tick 连点 → 一次建多条任务
```

| 阶段 | 用户能看见的失败 | 根因层级 | 最终落点 |
|---|---|---|---|
| A | 等结果时没进度、停不了、刷新丢流 | 传输与运行时 | 门铃 SSE + 文本 hub + cancel |
| B | 「您想买什么？」、标题一直「新选购」、请求打爆 | NLU 落地 + 前端订阅 | `ground_dialogue_act` + SSE 与轮询拆开 |
| C | 排除后又推回来、同一句说两遍、太贵了没记账、推荐跑题、连点建多任务 | 信念身份、事件投影、言语行为、硬过滤、提交锁 | listing key、线程折叠、stance 纠偏、品类相关性、ref 锁 |

---

## 2. 流式与命令：为什么不换 WebSocket

### 2.1 当时的备选

| 方案 | 主张 | 否决原因 |
|---|---|---|
| 全双工 WebSocket 一管到底 | 一个连接推命令和事件 | 命令需要 202 / 版本冲突 / 取消的 HTTP 语义；重连后难对齐「哪条命令已接受」 |
| 只轮询 GET | 实现简单 | 研究 8–20s，4s 一轮体感钝，且忙时仍会打满 snapshot |
| **REST 命令 + 两条 SSE** | 命令仍是资源，事件仍是日志 | 与「事件表为真」一致，刷新可用 `?after=` / `Last-Event-ID` 续读 |

### 2.2 落地拓扑

```text
POST /missions/{id}/turns          → 202 + run_id
GET  /missions/{id}/events         → 耐久领域事件（可续读）
GET  /missions/{id}/runs/{run_id}/text → 本轮 ephemeral token
POST /missions/{id}/runs/{run_id}/cancel → run.cancelled
```

写路径是 **write-then-notify**：

1. 业务事务写入事件表  
2. `UoW.commit()` 后 `MissionEventBroker.notify(mission_id, seq)`  
3. SSE 等门铃再 `list_since`；15s heartbeat 只是安全网  

关键文件：`backend/application/ports/event_broker.py`、`backend/infrastructure/runtime/in_process_broker.py`、`backend/infrastructure/persistence/unit_of_work.py`、`backend/api/routes/events.py`、`backend/api/sse.py`。

### 2.3 前端订阅怎么改过一次

**旧方案**：忙时 `shouldPoll` 写在 SSE `useEffect` 依赖里。`turn_phase` 一变就拆连接，重连时 `after=0` 把历史事件再播一遍，`onEvent` 触发 invalidate，形成 GET 风暴（含尚不存在的 recommendation 404）。

**新方案**：

- SSE 订阅与忙时轮询拆成两个 effect，订阅生命周期只跟 `missionId` 走  
- `onEvent` 用 ref，避免回调身份变化导致重连  
- invalidate 80ms debounce  
- `GET recommendation` 仅当 `mission.recommendation_run_id` 存在  

关键文件：`frontend/src/features/missions/useMissionEvents.ts`、`useMissionCommands.ts`、`frontend/src/api/types.ts`（`responding` 算 busy）。

`submit_message` 在 202 当下就把 `turn_phase=RESPONDING`，否则 UI 在派单后有一段「看起来能再发」的空窗。

---

## 3. 对话分类：模型优先，确定性纠偏

### 3.1 问题 1：首句被收成 unknown

首页默认句「帮我找一副适合通勤的降噪耳机，预算 2500 元以内」在 DeepSeek `parse_turn` 上曾返回 `unknown` + `requires_clarification`。确定性 `extract_query` 其实能抽出品类。UI 于是问「您想买什么？」，标题停在「新选购」。

| 方案 | 取舍 |
|---|---|
| 关掉 LLM，只走规则 | 丢开放式 soft_prefs 和复杂句 |
| 模型失败再 fallback | 模型**成功但漏抽**不会走进 fallback |
| **模型结果再 `ground_dialogue_act`** | 只补 REFINE/UNKNOWN 的 query/budget/markets，不改 COMPARE/ASK/STANCE |

第一版 grounding 明确写了「不改态度」。联调第二轮证明这句话过早。

### 3.2 问题 2：「太贵了」被收成 refine

徒步鞋场景里用户发「太贵了」，模型给出 `refine_constraints`。信念不记 `price_sensitivity`，简报没有「觉得偏贵」，回复也不提「已记下更便宜」。预算没变（对），态度丢了（错）。

确定性 `classify_turn` 对「太贵 / 再便宜」早有 `STANCE`。

**否决**：在 persist 里用正则补一句话。态度必须进 `PreferenceBelief`，否则下一轮排序/解释对不齐。

**采用**：grounding 第二刀。若模型给的是 REFINE/UNKNOWN，而确定性分类是言语行为（STANCE / REJECT / COMPARE / ASK / UNDO / META），**改回言语行为**。STANCE 的 patch 走 `_stance_patch`，禁止把残句写回 `query`。

```text
用户原文
   │
   ├─ LLM parse_turn          优先，保留 soft_prefs
   │
   └─ ground_dialogue_act
         ├─ 模型 = refine/unknown 且规则 = 言语行为 → 改 kind
         └─ 否则只补 query / budget / markets
```

关键文件：`backend/application/services/nlu.py`（`ground_dialogue_act`、`classify_turn`）、`backend/agent/nodes/dialogue.py`（LLM 与规则两条路径都 ground）。

测试锚点：`tests/test_dialogue.py` 的 `test_ground_recovers_wrapped_first_turn`、`test_ground_recovers_stance_when_model_returns_refine`。

---

## 4. 检索词：整句进 query 的代价

### 4.1 旧行为

`extract_query` 在 leftover 里看到「显示器」就把**整段 leftover** 当 query。  
「适合远程办公的 27 寸 4K 显示器，3000 元以内」里，「3000 元以内」没有「预算」前缀，第一套预算剥离规则剥不掉。BuyWhere 拿到长中文句子，召回里混进线材、记事本。

标题栏直接渲染 `constraints.query`，所以工作区标题也变成整句。

### 4.2 新行为

`_strip_known_slots` 增加两刀：

- `适合…的` 用途前缀  
- 残留 `\d{3,6} 元以内`  

于是默认耳机句收成「降噪耳机」，显示器句收成「27 寸 4K 显示器」。

**不选**「只用 LLM 重写短 query」：模型已证明会漏抽；短 query 必须由确定性层保证。模型仍可在后续 refine 里写成「27寸 4K 显示器 远程办公」，这是可接受的检索增强，不是首轮兜底。

关键文件：`backend/application/services/parse_intent.py`。

---

## 5. 否定候选：snapshot_id 为什么不够

### 5.1 线上复现

耳机任务：点「不要这款」排除红色 COWIN E7，立刻改推白色，简报「已排除 1 件」。  
再点「预算 2000 元」触发**重搜**，推荐文案仍写「已排除你否定过的候选」，首选却又是红色款。

### 5.2 旧方案

信念只存 `rejected_snapshot_ids`。`run_filter` 用当前 `snapshot_map[source_id] → snapshot_id` 对齐。

重搜后 persist **新建** snapshot：

```text
旧：src-red → snap-aaa   （被 reject 记入 belief）
新：src-red → snap-bbb   （新 ID，不在 rejected 里）
```

研究工具里甚至传入 `snapshot_map={}`，过滤条件变成「`product.id` 是否等于旧 snapshot UUID」，永远对不上。

同轮 refilter（不重搜）能对上，所以第一下「不要这款」看起来是好的。一换预算就穿帮。

### 5.3 备选与取舍

| 方案 | 主张 | 否决 / 采用 |
|---|---|---|
| 重搜后把旧 snapshot 的 source_id 反查出来 | 不改信念模型 | 要读历史 candidate_set，研究节点当下没有这份图 |
| persist 时把新 snapshot_id 并回 rejected 列表 | UI「已排除 N」好看 | 同款会累计两条 ID，计数膨胀；过滤仍缺研究时身份 |
| 否定改记 `excluded_terms=标题` | 实现快 | 颜色变体标题几乎相同，会误伤整组 COWIN E7 |
| **listing key 与 snapshot_id 并存** | 跨轮对齐，旧路径兼容 | 采用 |

### 5.4 当前身份

`PreferenceBelief.rejected_listing_keys` 在 `reject()` 时写入：

```text
snap:{snapshot_id}
src:{source_product_id}
url:{normalized_url}
title:{normalized_title}|m:{merchant}
```

`apply_act_effects` 从当前 ranked 记录抽出这些 key。  
`run_filter` / `run_rank` / 研究工具 / 图节点 refilter **同一套** key 求交。

关键文件：

- `backend/application/services/rec/identity.py`（新建）  
- `backend/application/dto/belief.py`  
- `backend/application/services/policy.py`  
- `backend/application/services/rec/pipeline.py`、`state.py`  
- `backend/agent/tools/catalog.py`、`backend/agent/nodes/decide.py`、`backend/agent/loop.py`

测试锚点：`tests/test_rec.py::test_run_filter_honors_listing_keys_after_new_snapshots`。

**仍未做**：颜色变体若标题只差 Red/White，`title|m` 不会误伤；若商户把两色写成同一标题，会靠 `src:` 区分。BuyWhere ID 不稳定时退回 title+merchant，存在误伤同名不同 listing 的可能。

---

## 6. 线程投影：事件真源 vs 气泡去重

### 6.1 为什么会双写

persist 为了两件事各写一条事件：

- `recommendation.ready`：工作区阶段、候选集、推荐草稿  
- `agent.message`：对话气泡、next_moves、文本 hub 终稿  

两者 payload 都带完整 `text`。`project_thread` 旧逻辑把它们映射成 `recommendation` + `agent` 两条，UI 同一句话出现两次。

### 6.2 备选

| 方案 | 取舍 |
|---|---|
| persist 不再写 `agent.message` | 文本流回放、talk 路径、取消后补文案都依赖它 |
| persist 不再给 `recommendation.ready` 带 text | 破坏「推荐卡片可独立投影」的旧事件 |
| **投影期折叠** | 事件表仍完整；同 `run_id` 已有 `agent` 则丢掉 `recommendation` 气泡 |

采用第三种。旧事件只有 `recommendation.ready`、没有 `agent.message` 的，气泡仍在。

关键文件：`backend/application/services/thread.py`（`_fold_thread`）。  
测试：`tests/test_dialogue.py::test_project_thread_keeps_one_reply_when_ready_and_agent_share_run`。

同函数里本来就会把同 run 的 `constraints.updated` 折进用户/助手气泡。这次是同一思想扩到 recommendation。

---

## 7. 排序与相关性：最低价不是品类

### 7.1 线上复现

「适合远程办公的 27 寸 4K 显示器，3000 元以内」召回约 80 件后，决策层按人民币估算升序，首选变成 *Blood Pressure Log Book*（约 ¥84）。HDMI 线、记事本因标题里偶尔出现 Monitor / 4K 混进列表。

这不是 BuyWhere 单独的锅：探索检索本来就会脏。缺的是**决策层品类门闩**。

### 7.2 备选

| 方案 | 取舍 |
|---|---|
| 让 LLM 在 finalize 前再筛一遍 | 贵、慢、会编 |
| embedding 相关性阈值 | 无现成索引，联调来不及，也难解释 |
| 标题必须含 query 全部 token | 「27 寸」「远程办公」会误杀英文 listing |
| **品类线索表 + 标题子串，空集则不筛** | 与排除词过滤器对称；假空集比脏推荐更糟，所以空集回退 |

`_CATEGORY_CUES` 按**更具体的提示优先**（徒步鞋先于鞋）。query 命中「显示器」则标题需含 monitor / display / 显示器 / 屏幕。血压本被丢掉；带 Monitor 的 4K 屏留下。

过滤位置在 `run_filter`：否定 → 库存 → **相关性** → 排除词 → 预算。这样重搜、refilter、研究工具共用，不会只在某一个节点生效。

关键文件：`backend/domain/policies/filter_rank.py`（`apply_relevance_filter`）、`backend/application/services/rec/pipeline.py`。

**已知残留**：FHD 办公屏标题含 Monitor，仍可能排在 4K 屏前面（最低价）。相关性只保证「是显示器」，不保证「是 4K」。规格字段 BuyWhere 经常缺失，不能假装按 4K 硬过滤。

---

## 8. 进度文案：工具调用次数 ≠ 用户心智

研究节点可能多次 `search_products`。序列曾是：

```text
已收到 8 件 → 正在检索 US、SG → 已收到 0 件 → 已收到 8 件
```

「0 件」是某一次工具结果，不是任务清空。

**不选**「后端禁止 count=0 的 `products.received`」：事件仍应记录空召回，便于排障。  
**采用**前端解释：count≤0 显示「补充检索没有新结果」；若已有「已收到 N」则不覆盖。

关键文件：`frontend/src/features/missions/useMissionEvents.ts`、`useMissionWorkspace.ts`。

---

## 9. 提交锁：React 状态来不及

`HomeView.start` 旧判断是 `create.isPending`。同 tick 里 `requestSubmit()` 两次，两次都看到 `isPending === false`，于是 12:03 一次连点冒出多条「新选购 / 正在回答」，每条都打了 live 检索。

`isPending` 要等 mutation 注册后的一次 render。对连点不够。

**采用**：`useRef` 立刻上锁 + 本地 `locked` 禁用按钮。失败再解锁。成功则导航离开，不必解锁。

对话发送本身已有 `busy`（`turn_phase` + mutation）。首页创建没有任务态，必须自己锁。

关键文件：`frontend/src/views/HomeView.tsx`。

---

## 10. 工作区崩溃

Vite HMR 在 `useMissionApi` 导出不兼容时会 invalidate Provider，页面进 ErrorBoundary，文案「Cannot read properties of null (reading 'destroy')」。源码里没有 `.destroy`，来自 HMR / 扩展，不是业务逻辑。

旧 ErrorBoundary 只有死页。现增加「重新打开」（`location.reload()`）。不在边界里尝试静默 `setState` 恢复：destroy 类错误的组件树往往已经卸掉。

关键文件：`frontend/src/app/ErrorBoundary.tsx`。

---

## 11. 联调对照（修复后）

| 话轮 | 期望 | 修复后实况 |
|---|---|---|
| 帮我买个东西 | 追问品类 | 澄清 + 三个品类 chip |
| 轻便徒步鞋 | 检索并推荐 | Athletique ~¥81，预算 ¥1000 |
| 不要这款 → 预算 800 重搜 | 被否款不再回来 | 仍推下一款跑鞋，简报「已排除 1 件」 |
| 太贵了 | 态度入信念，预算不动 | 「觉得偏贵」+「已记下更便宜，但没有改硬预算」 |
| 4K 显示器 | 推荐显示器 | MSI / LG / ViewSonic，约 ¥947 起 |
| 预算 800 块（无品类） | 只记账预算并追问 | ¥800 + 品类 chip，不空搜 |
| 空白发送 | 禁用 | 禁用 |
| 首页连点 | 一条任务 | ref 锁后一条 |

---

## 12. 文件对照（按变迁）

| 变迁 | 新增 | 主要改动 |
|---|---|---|
| 流式骨架 | `backend/api/sse.py`、`application/ports/event_broker.py`、`ports/run_progress.py`、`services/progress.py`、`infrastructure/runtime/in_process_broker.py` | persist / dispatcher / events 路由 / 前端 workspace |
| 品类 grounding | — | `nlu.py`、`dialogue.py` |
| 否定跨轮 | `rec/identity.py` | `belief.py`、`policy.py`、`pipeline.py`、`catalog.py`、`decide.py`、`loop.py` |
| 线程去重 | — | `thread.py` |
| 态度纠偏 | — | `nlu.py` `ground_dialogue_act` 第二刀 |
| 短 query | — | `parse_intent.py` `_strip_known_slots` |
| 品类门闩 | — | `domain/policies/filter_rank.py`、`pipeline.py` |
| 进度 / 连点 / 崩溃 | — | `useMissionEvents.ts`、`useMissionWorkspace.ts`、`HomeView.tsx`、`ErrorBoundary.tsx` |

测试主要加在 `tests/test_dialogue.py`、`tests/test_rec.py`、`tests/test_filter_rank.py`、`tests/test_event_stream.py`、`tests/test_sse.py`。

---

## 13. 以后不要退回去的几条

1. **事件表是真，SSE 是门铃。** 不要为了「推得更快」让前端只信内存里的 delta。  
2. **模型输出必须 ground。** 成功响应里的漏抽和误分类，比抛错更常见。  
3. **否定对象是 listing，不是某一次 snapshot。** 重搜会换 ID。  
4. **最低价不能越过品类。** 探索召回默认脏。  
5. **残句不是 query。** 「太贵了 / 再便宜一点」不得覆盖检索词。  
6. **同 run 的推荐事件和助手消息在投影期去重，不要在写入期删事件。**

这六条是本轮方案变迁收束后的约束；下一轮若要动流式、NLU 或过滤，先对照这里的失败案例。

工作记忆、规格门闩、否定身份与比较集指代的后续变迁见 [working-memory-scheme-evolution.md](./working-memory-scheme-evolution.md)。
