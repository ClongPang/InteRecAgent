# Agent 架构梳理

**版本**：1.4  
**日期**：2026-08-22  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：现行架构走读 + 目标形态对照（给「哪些环节改成模型为主、规则为辅」拍板用）  
**范围**：从入口分流到落库的完整 Agent 链路；§9 起为口语回合的目标形态与现行对照。不替代选型总文与各方案变迁文。

相关文档：

- [技术架构与选型](./technical-architecture-and-selection.md) — 总体选型与三层职责
- [话轮路由与模型窗口](./dialogue-route-scheme-evolution.md) — 五选一路由、模型看见什么
- [研究控环](./research-loop-scheme-evolution.md) — keep / 改写 / TopK
- [工作记忆](./working-memory-scheme-evolution.md) — DST 与三角色投影

事实层 / 决策层 / 语言层的职责分离不变：模型可以漏抽、误分类；价格、库存、保修、链接不得编造。

---

## 1. 总览：三层 + 一张图

整条链路是 **一条 run 只走一条支路** 的状态机，不是模型自己点工具的 ReAct。

```text
用户一句话 / PATCH / undo
        │
        ▼
命令层 MissionCommandService          ← 通道分流，不是意图分类
  · MESSAGE：只写 message.received + 派单（句子语义不下预判）
  · PATCH：DialoguePolicy 确定性改约束再派单
  · undo：进图前拦截，回溯约束再派一趟
        │
        ▼
LangGraph 外层（每趟都跑）
  receive → decide → execute_ops → persist
        │
        execute_ops 内按世界变化调用：
        ├─ clarify  → 直接回 persist
        ├─ talk     → 读缓存 → grounded 回复
        ├─ rerank   → 读缓存 → 排序 → 证据 → 起草
        ├─ refilter → 读缓存 → 过滤 → 排序 → 证据 → 起草
        └─ research → 研究环 → 证据 → 起草
```

记忆模型是 `ShoppingMission`（约束 / 信念 / 工作集 / 版本），不是聊天记录。模型只看见 `model_context` 投影，禁止 dump 全量 belief。

| 层 | 干什么 | 禁止 |
|---|---|---|
| **事实层** | 商品快照、汇率、库存、链接 | 模型补价格 / 库存 / 保修 |
| **决策层** | 过滤、排序、路由、停搜、选题 | 模型发明 ID、改硬预算 |
| **语言层** | 分类、软偏好、改写 query、解释草案 | 未被证据支持的商品断言 |

现行判断主体已经拆开：

- **理解**（这句话是什么、软偏好是什么）：模型为主
- **控环**（走哪条路、搜几次、何时停、问哪个槽）：规则为主
- **取舍**（这件像不像要买的、池子里留哪几件）：研究路径模型为主，缓存路径仍偏规则
- **说话**（talk / ready 展示句）：规则为主；库里的 recommendation draft 才是模型

---

## 2. 入口分流：分的是交互通道，不是购物意图

### 2.1 技术名词

入口做的不是 Intent classification，也不是 Router Agent。对应说法：

| 说法 | 对应什么 |
|---|---|
| **Command dispatch / Command pattern** | 用户动作先收成带类型的命令。代码里是 `TurnCommand`：`message \| patch \| undo` |
| **In-band vs out-of-band** | 口语把意思写在句子里；PATCH / 撤销按钮走旁路信号 |
| **NLU bypass** | 结构化回合跳过理解。Rasa `/intent`、Dialogflow event 同类 |
| **Dialogue control act** | 撤销 / 取消是交际管理，不是「我要买耳机」 |
| **Ingress routing** | 进编排器之前的门禁，不是又一个小 Agent |
| **控制反转** | 本仓库用语：自由文本的理解权交给图，命令层不再预判 kind |

容易混淆：

| 词 | 通常指 | 是不是这件事 |
|---|---|---|
| Semantic Router | 用 embedding 判这句话去哪个 Agent | 否。这里判的是命令类型 |
| Supervisor / Triage Agent | 模型调度员选子 Agent | 否。没有模型调度员 |
| Intent classification | refine / stance / 不要这款 | 那是图里的 `parse_decision` |
| ReAct / plan-and-execute | 模型自己决定下一步 | 相反：入口和环都由后端收 |

一句话：**确定性预路由**。门的类型早绑，句子的语义晚绑。

### 2.2 分的是什么

入口只回答三选一：

1. 有一句待理解的原文吗？→ MESSAGE  
2. 约束字段已经改好了吗？→ PATCH  
3. 只要把约束滚回去吗？→ undo  

不回答「用户想买什么」。那是进图之后的 `DialogueAct`。

### 2.3 谁在分、怎么分

三层，都不是模型。主判官是前端：输入框、侧栏、撤销按钮走不同函数。

```text
用户点了什么 / 打了什么
        │
        ▼
① 前端选 API          ← 主分流（控件决定通道）
        │
        ▼
② HTTP 路由选 Service  ← 只转发，不理解句子
        │
        ▼
③ submit_message 正则  ← 唯一「看了一眼原文」
        │                 只认撤销词，不当 NLU
        ▼
   对应方法 + 派 run
```

| 用户动作 | 前端 | HTTP | 后端方法 |
|---|---|---|---|
| 输入框回车 | `sendMessage` → `command: 'message'` | `POST .../turns` | `submit_turn` → `submit_message` |
| 侧栏改预算 / 仅看有货 / 排序 | `patchConstraints` | `PATCH .../constraints` | `update_constraints` |
| 点「撤销」 | `undo` → `command: 'undo'` | `POST .../turns` | `submit_turn` → `undo` |
| 打字「撤销」 | 仍走 `sendMessage` | 同上 `message` | `submit_message` 开头正则改道 `undo` |

`POST /turns` 的 `command` 只能是 `message | undo`。PATCH **不走 turns**，另开约束接口。`TurnCommand.PATCH` 只在 Service 内部用。

口语通道里的撤销闸（`frames.py`）：

```text
text 匹配 /撤销|还原刚才|刚才的条件|undo/i
  → 整段改走 undo()，不写 message.received
```

这是 closed-class 拦截：只认控制词，不抽预算、不判 kind。按钮撤销不进这层。

比较集（`PUT /comparison`）是第四个动作：只改 `comparison_snapshot_ids`，**不派 Agent**。不是这三扇门。

### 2.4 每个入口进门时改什么

共同的只有：校验 `constraints_version`（对不上 409），然后通常派一趟 run。差别在 **进图前 mission / 事件已经变成什么样**。

#### MESSAGE（一句口语）

进图前 **不改购物约束**。命令层只记账。

| 改 | 不改 |
|---|---|
| 追加 `message.received`（原文 + `run_id`） | `constraints` |
| `active_run_id`、`turn_phase = responding` | `constraints_version`（图 persist 时约束真变了才加） |
| 若点了某件商品：`dialogue.focus_snapshot_id` | 信念、候选集 |

图启动后才：`parse_decision` → 副作用 → 合并约束 → 选路。  
「只要 Sony」的约束是 **图跑完才写入**。

#### PATCH（填好的表单）

进图前 **约束已经改完**。没有 `text`，所以跳过理解。

| 改 | 不改 |
|---|---|
| `constraints`（与当前合并后的新值） | 不写 `message.received` |
| 内容变了才 `constraints_version + 1` | 不跑 `parse_turn` |
| `constraints.updated`（带 before/after，undo 靠它） | 用户气泡（线程上只有系统「已更新…」） |
| `turn_phase`（多为 refiltering / researching） | |

`DialoguePolicy` 只做确定性护栏：当前 query 不像耳机，就不写入「优先续航」；新旧一样则 **不派单**。

图里 `receive_message` 找不到本 run 的用户话，只看到约束事件 → `skip_intent_patch = true`：不再合并一遍，按新约束 `refilter` 或 `research`。

否则会出现：侧栏已经写成预算 2000，图又拿空文本去 `parse_turn`，把刚写好的约束冲掉，或走到「您想买什么」。

#### undo（回滚账本）

进图前 **约束被换成上一笔的 before**。不当新意图。

| 改 | 不改 |
|---|---|
| `constraints` ← 最近一条带 query 的 `constraints.updated.before` | 信念（「不要这款」、太贵了仍在） |
| `constraints_version + 1`（和当前不同才加） | 不写用户原话 |
| `constraints.undo` | 候选集先不动，由随后那趟 run 按恢复后的约束重算 |
| `dialogue.last_act = undo` | |

找不到可撤的 `constraints.updated` → `NothingToUndo`。  
图同样 `skip_intent_patch`，按滚回去的约束重跑。

undo 必须在进图前做完：模型可能把「撤销刚才那个」收成换 query；图也不能可靠地在事件日志里找上一笔。

### 2.5 同一句「预算 2500」走两扇门

**打字「预算 2500 元」**

```text
前端: message
命令层: 只记账，约束仍是 4000
图: 理解成 refine → merge 写成 2500 → persist 发 constraints.updated → 版本 +1
```

**侧栏填 2500**

```text
前端: PATCH { budget_cny: 2500 }
命令层: 约束已是 2500，版本已 +1，已有 constraints.updated
图: 跳过理解，按 2500 重滤/重搜
```

结果都可以是预算 2500，但 **谁改约束、何时加版本** 不同。undo 回滚的是事件里的 before，两条路只要写过 `constraints.updated` 都能撤。

| | MESSAGE | PATCH | undo |
|---|---|---|---|
| **分的是** | 有原文，待理解 | 字段已就绪 | 只要恢复旧约束 |
| **谁分** | 输入框 → API；正文若像撤销再改道 | 侧栏 → 另一条 API | 按钮直接 undo；或口语闸改道 |
| **靠什么** | 通道 +（可选）撤销正则 | HTTP 路径，无语义 | command 或正则，无模型 |
| **进图前约束** | 旧的 | 已是新的 | 已是上一笔 |
| **进图前版本** | 不动 | 变了才 +1 | 变了才 +1 |
| **关键事件** | `message.received` | `constraints.updated` | `constraints.undo` |
| **图是否理解** | 是 | 否（`skip_intent_patch`） | 否 |
| **图主要干什么** | 分类 + 可能改约束 + 选路 | 按新约束重算候选 | 按恢复后的约束重算 |

入口分流 **不该** 改成模型为主：MESSAGE 的接待只记账；PATCH 没有自然语言；undo 是回滚。要改的是图里的 classify / 路由 / 说话。

---

## 3. 上下文会不会断

三条门不会把 **任务记忆** 撕开。它们拆的是「这一趟 run 怎么触发」，不是「还记不记得刚才发生了什么」。

会让人觉得断的，是另一件事：**模型并不读完整聊天记录**。任务连续，靠的是 `ShoppingMission`，不是把历史原话一路传下去。

### 3.1 连续的是任务，不是聊天窗口

权威状态一直是同一份 mission：

- 约束：query / 预算 / 市场 / 仅看有货
- 信念：太贵了、不要这款、软偏好、已问过的槽
- 工作集：当前对照、比较集、焦点商品
- 事件账本：每句话、每次改约束、每次撤销

MESSAGE / PATCH / undo 最后都写进这份状态，再派一趟 run。图启动时读的是 **当前 mission + 缓存候选**，不是「上一条入口类型」。

侧栏把预算改成 2500 之后再打「太贵了」：分类器看见的 `budget_cny` 已经是 2500，过滤仍按 2500，上一轮候选还在。

### 3.2 用户看见的线程是拼起来的

`project_thread` 把事件收成一条时间线：

| 事件 | 用户看见 |
|---|---|
| `message.received` | 你的气泡 |
| `agent.message` / 推荐 | 助手回复 |
| `constraints.updated` | 「已更新：预算 2500 元」 |
| `constraints.undo` | 「已撤销最近一次约束变更」 |

同一趟 run 里，改约束会贴在那句回复上。侧栏 PATCH 没有用户气泡，会留下一条系统变更，下面接重算后的推荐。

聊天记录不断，是因为 **事件账本不断**，不是因为三扇门共用一个 prompt。

### 3.3 真正变薄的是模型窗口

分类器每趟只吃：

- 当前约束和 DST 摘要（预算、用途、排除、价格态度）
- 上一句用户 + 上一句助手
- 焦点商品、比较集、对照前三件

研究环更窄：只看检索词、池子 brief，**不看聊天**。

这是故意的。否决过「把全程对话塞进模型」和「再加一个摘要器」，因为指代、比较集、否定对象会被摘要写丢，而且贵、不可复现。

- 「白色那个呢」——连续，因为比较集 / focus / 工作集还在
- 「你第一轮推荐的那款呢」且那款已不在对照里——会断，这是窗口设计，不是三扇门造成的
- 侧栏改完预算再说「按刚才那个」——模型的 `last_user` 仍是上一句口语；它靠 DST 里已经更新的预算接上

### 3.4 真会让人觉得「断了」的地方

1. **PATCH 在对话里没有用户原话**  
   侧栏改预算，线程上只有系统句。下一句口语指代「刚才改的」，模型不一定把侧栏操作当成上一轮发言。任务层连续，叙事层偏淡。

2. **undo 只回滚约束，不回滚信念**  
   撤销预算会回去；「不要这款」记在 `rejected_snapshot_ids` 里，不会跟着约束一起恢复。

3. **模型看见的历史只有邻接一对**  
   隔了好几轮再说「最早那双」，若不在工作集/比较集里，就会对不上。

任务上下文不断，聊天流水不断；断的是「模型当 ChatGPT 那样读完全程」。

---

## 4. 图前半段：理解 → 副作用 → 合并 → 路由

关键文件：`backend/agent/graph.py`、`backend/agent/nodes/fetch.py`、`backend/agent/nodes/dialogue.py`、`backend/agent/nodes/decide.py`、`backend/application/services/route.py`。

### 4.1 `receive_message`

加载 mission、绑定本 run 的触发事件、建 `TurnView`、读缓存。无语义判断。

优先 `message.received`；PATCH / undo 只有约束事件 → `skip_intent_patch=true`，后面跳过自然语言分类。调度器追加的 `run.accepted` 也属约束触发，若不优先取消息事件，会把用户话轮误判为「约束已就绪」。

### 4.2 `classify_dialogue_act`　★ 阶段 1：一次决策，ground 只绑定

产出 `TurnPlan`（`ops` + leftover + lead）。`dialogue_act` 仍是 lead，供副作用 / persist 兼容。

```text
有模型 → parse_decision（JSON：ops[]，或兼容单 act）
无模型 / 失败 → propose_plan（句式框架）
两条路径都再过 bind_oral_plan → ground_dialogue_act（只绑槽与指代，不改 kind）
```

规则在这里做的不是「另选一条路」，而是绑定与护栏：

| 规则落点 | 作用 | 为何存在 |
|---|---|---|
| `frames.collect_acts` / `propose_plan` | 封闭动词：有…吗 / 不要 / 帮我比 / 太贵了 | 无 Key 底线；模型失败时拆 ops |
| `ground_dialogue_act` | 补封闭槽、绑 referent；不改已判定的 kind | 模型漏槽时补硬槽；句式不得盖模型 |
| `parse_intent` | 预算/市场/query leftover（仅 REFINE/UNKNOWN） | 模型漏槽时补硬槽 |
| `sanitize_dialogue_act` | talk 类清掉 query；软偏好去 price/weight | Schema 护栏 |
| `World.lookup` | 「那个白色」绑到当前候选 | 开放名词不进词表，对着工作集求值 |

阶段 1 已落地：模型出完整 `TurnPlan.ops`；规则不再用 `propose_plan` 盖 lead，也不再用句式把 REFINE 改成 STANCE / 把 ASK_ITEM 改成只看有货。UNKNOWN 在 query 槽补上后仍可升为 REFINE（槽补全，不是句式覆盖）。`parse_turn` 保留作单 act 兼容入口。

### 4.3 `apply_turn_effects`

把 act 写进信念：价格态度、否定 listing key、不支持的「更轻」。

现行纯规则（`apply_act_effects`）。这是状态机副作用，不是理解。应保持规则。模型已经在 classify 里给出 stance/reject，这里只落账。

命令层 `DialoguePolicy` 与图节点共用同一函数，保证 PATCH 预判与图内路径信念不漂移。

### 4.4 `merge_mission_state`

`IntentPatch` → `MissionConstraints` + belief（use_case / spec_gates / soft_prefs）。版本不在这里加，persist 时才比内容。

- 提问/对比/meta/undo：**不改约束**
- `sanitize_constraints`：无音频规格时丢掉 battery/noise 排序偏好
- `resolve_probe_coverage`：用户答了挂起的槽则消解，否则记 skipped

合并与护栏应保持规则。可讨论的只有「要不要让模型决定 patch 哪些槽该覆盖」——但那已经在 classify，不是 merge。

MESSAGE 路径：约束在这里合并，persist 时才加版本。  
PATCH 路径：`skip_intent_patch`，这里不再合并。

### 4.5 `execute_ops`　★ 阶段 2：按世界变化选计算工具

`route_after_world` **不读 `kind`**。先执行 undo / 信念 / 约束，再看世界变了什么：

| 世界 | 路由 | 含义 |
|---|---|---|
| 通道已写 `decided_route` | 尊重通道 | PATCH / 按钮不重判 |
| 只有 talk op，约束没变 | `talk` | 提问/对比不碰商品源 |
| 排除 / 否定 / 约束变了 + reuse 对得上 | `refilter` | 本地滤 |
| 只有态度，约束没变 + 有缓存 | `rerank` | 「太贵了」只重排 |
| 无 query | `clarify` | 缺品类 |
| reuse 对不上 / 首次 | `research` | 换品类、改预算、缓存失效 |

附加规则：商户过滤在工作集没命中 → 升级 `research`；「更轻」且无重量字段、又没有别的过滤 → 强制 `talk`。

`search_reuse_key` = `{query, markets, budget_cny}`。预算进原币 max_price，必须进键。

五条计算支路仍是这些实现，但留在 `execute_ops` 内部。外层图不再按 kind 查边。

---

## 5. 五条支路

### 5.1 `clarify`

无品类。persist 里 `select_probe` 出一句追问。不检索。

### 5.2 `talk` → `compose_grounded_reply`

只读缓存。已知 topic（保修/库存/为什么/对比/概述）按 CitedFacts 答；对不上的开放问句说没有该字段，不再默认概述第一件。

现行纯规则，模型不写 talk。指代：`referent_ranks` / `World.lookup` / focus。对比：`compare_candidates` 算差，再 `_render_compare` 拼句。

语言层里最保守的一块。改成「模型写话、规则只供 `CitedFacts`」收益最大（自然度），风险也最大（编保修/库存）。护栏应是：模型只收 `CitedFacts`，禁止的字段列表仍由规则生成。

### 5.3 `refilter` / `rerank`

复用快照，不打 BuyWhere。

- `run_filter`：预算、库存、排除词、否定 listing、spec_gates、品类相关性词表
- `run_rank`：`score_and_rank` + belief 软偏好 cues

硬过滤必须规则（人民币预算、无货、已否定 ID）。品类相关性词表（`_CATEGORY_CUES`）和研究环的 `judge_keep` 有重叠——研究路径已把「像不像要买的」交给模型，refilter 仍用词表。这是决策层里最值得对齐的不一致。

### 5.4 `research`：后端控环，模型只出三次 JSON

控制器在 `backend/agent/loop.py`。模型 **不能** 决定搜几次、何时停、工具顺序。工具目录还在，但是控制器点，不是 ReAct。

```text
while search_count < R=3:
    search_products          # 确定性，可带原币预算上限
    filter_candidates        # 内部先 FX 再硬过滤（顺序焊死）
    judge_keep               # ★ 模型勾选本轮 ID；失败则本轮不并入
    merge_into_pool          # listing 去重累加
    停搜：次数用尽 / 池子≥25 / decision_quality.discriminable（≥2 件且≥2 个可分辨轴）
    否则 rewrite_query       # ★ 模型改检索词；失败则放宽原币上限或扩市场
停搜后:
    select_topk              # ★ 模型从池子选 K=6
    失败 → score_and_rank
    select_decision_set      # 规则截决策集
```

| 模型步 | 输入 | 失败策略 | 规则辅什么 |
|---|---|---|---|
| `judge_keep` | 标题/商户/市场/人民币价，最多 40 件（多则规则先粗排） | 本轮整批不进池 | ID 必须落在本批 |
| `rewrite_query` | 当前词、已用过的词、池子样本 | 放宽 cap / 扩默认市场 | 不得换品类、不得改预算 |
| `select_topk` | 全池 brief + 预算/偏好/用途 | 回退规则分 | ID 必须在池内，再被决策集规则截断 |

停搜的 `decision_quality`（形态/商户/市场/价差）是纯规则。

研究环已经是「模型判相关性与取舍、规则控环与硬闸」。还可讨论的只有：停搜要不要模型建议（规则否决次数/空池）；refilter 的词表闸要不要也改成 keep 式模型。不要退回自由 ReAct（已否决）。

### 5.5 检索之后：证据 → 起草 → 落库

| 环节 | 作用 | 现行 | 标注 |
|---|---|---|---|
| `verify_evidence` | 用 ranked[0:3] 建 `RecommendationDraft` | 纯规则模板理由 | 事实草稿，应保持规则 |
| `compose_recommendation` | 模型改写 rationale/tradeoffs | 模型起草 + ID 求交 | 已是模型为主；失败留规则草稿 |
| `persist_decision_snapshot` | 写快照、候选集、事件、版本冲突 → superseded | 纯规则 | 唯一写库点。禁止模型碰 |
| `compose_ready_reply` | research/refilter 路径的用户可见句 | 与 `RecommendationDraft` 同源 | 阶段 3：有 draft 则用其 rationale/tradeoffs，ID 必须在 ranked |

---

## 6. 横切：工作集、信念、投影、追问

| 模块 | 作用 | 判断主体 | 标注 |
|---|---|---|---|
| `WorkingSet` | pool=绑定宇宙，display=对照 K | 结构，无判断 | 保持 |
| `World` | 开放针（平台/品牌/色）绑到当前候选 | 规则求值 | 指代绑定应保持规则；模型给 needle，规则落地 ID |
| `PreferenceBelief` | 价格敏感、否定、软偏好、asked/skipped slots | 由 effects/merge 写 | 状态，不是分类器 |
| `TurnView` | 分类窗口：邻接对 + DST + 工作集预览 | 投影规则 | 禁止把全程 transcript 塞给模型 |
| `ResearchContext` | 本趟池子；只把 ID+brief 给模型 | 投影规则 | 保持 |

`assess_uncertainty` 扫全部可兑现未知。`choose_probe` 让模型从该列表挑一条，规则否决列表外 slot；无 query 时 QUERY 不可跳过。无模型则 `select_probe` 按严重度降级：

1. 无 query（blocking）
2. 无预算且价差 ≥ 400
3. 候选被形态撕成两簇（头戴/入耳词表）
4. 否定了但没原因

不可问：直邮、保修、评分。问句必须能兑现进 IntentPatch。`next_moves_for` 按 kind/topic/价差/品牌拼 chip。

这是「问什么」的策略，不是「怎么问」。改成模型选题，风险是问不可兑现的（保修、直邮）或连问多槽。若改：模型在 `Uncertainty[]` 里挑一条，规则禁止越界 slot。问句措辞可以模型写，slot 集合应保持封闭。

---

## 7. 拍板对照表

按「改成模型为主、规则为辅」的 **可讨论程度** 排，不是建议清单。

| # | 环节 | 现行 | 模型若为主，规则应辅什么 | 改了会碰到的已知失败 |
|---|---|---|---|---|
| A | talk 回复措辞 | 已知 topic 模板；对不上说没有 | 只喂 CitedFacts；禁保修/库存/运费断言 | 编造未提供字段（阶段 3 已收默认概述） |
| B | research/refilter 展示句 | 与 draft 同源 | 同上；ID 必须在 ranked | draft 与可见句两套（阶段 3 已收） |
| C | 并列句 / 完整 TurnPlan | 模型 `parse_decision` 出完整 ops；规则只在失败时拆 | schema + 指代绑定；不再句式盖 kind | 「对比且不要入耳」只做一半（阶段 1 已收） |
| D | 追问选题 / 下一句 | 模型从 Uncertainty[] 挑；规则否决越界 | 只能从封闭 SlotId 里挑；不可问列表否决 | 问保修、连问、与过滤对不上（阶段 3 已收） |
| E | `execute_ops` 选路 | 按世界变化，不读 kind | 无 query 必 clarify；talk 禁检索；reuse_key 否决误 research | 问保修打 API；改预算用旧召回（阶段 2 已收） |
| F | 停搜 | 次数/池阈值/可分辨轴 | 次数与空池硬停；模型最多建议「再搜一次」 | 因 sample 难看空转 |
| G | refilter 品类词表 | 规则闸 | 与 keep 对齐：词表只挡已命名脏模式，开放相关性交给模型 | 型号名误杀 / 配件打穿 |
| H | kind 的 ground 覆盖 | 只补槽、只绑 ID，不改 kind | 已就位 | 复杂句被规则拽回错误 kind（阶段 1 已收） |
| — | classify `parse_decision` | 已是模型为主 | 已就位 | — |
| — | keep / rewrite / TopK | 已是模型为主 | 已就位 | — |
| — | 推荐起草 | 已是模型为主 | ID 求交 | — |
| — | 硬过滤 / FX / 落库 / PATCH / undo / 入口分流 | 应保持规则 | 不是判断点 | — |

风险类型不一样，适合分开拍：

- 先动 **说话（A/B）**：编造
- 先动 **控环（D/E/F）**：乱花检索、问错槽
- 先把 **缓存路径的相关性（G）** 和研究环的 keep 对齐：误杀/漏杀

---

## 8. 关键落点

| 主题 | 文件 |
|---|---|
| 图装配与条件边 | `backend/agent/graph.py` |
| 命令入口 | `backend/application/services/mission_service.py` |
| 前端通道选择 | `frontend/src/features/missions/useMissionCommands.ts` |
| HTTP 路由 | `backend/api/routes/missions.py` |
| 接收与触发绑定 | `backend/agent/nodes/fetch.py` |
| 分类 / talk / 读缓存 | `backend/agent/nodes/dialogue.py` |
| 合并 / 过滤 / 排序节点 | `backend/agent/nodes/decide.py` |
| 研究节点 | `backend/agent/nodes/research.py` |
| 研究控环 | `backend/agent/loop.py`、`backend/agent/judges.py` |
| 证据与起草 | `backend/agent/nodes/evidence.py` |
| 落库 | `backend/agent/nodes/persist.py` |
| 路由规则 | `backend/application/services/route.py` |
| 句式框架 / 撤销正则 | `backend/application/services/frames.py` |
| 世界动作（undo 执行器） | `backend/application/services/turn_actions.py`、`backend/agent/nodes/turn_actions.py` |
| PATCH 政策 | `backend/application/services/policy.py` |
| 追问选题 | `backend/application/services/uncertainty.py` |
| 模型窗口 | `backend/application/services/model_context.py` |
| 线程投影 | `backend/application/services/thread.py` |
| LLM Port 与提示 | `backend/application/ports/model_backend.py`、`backend/infrastructure/llm/openai_compat.py` |

---

## 9. 目标形态：通道直达，口语一次决策 + 世界动作

§1–8 是现行走读。本节是针对开放用户输入的重构形态：**控件已经标明的动作直接执行；只有输入框里的原句，才经过「看世界 → 一次决策 → 按工具改世界」。**

不推翻研究环拍板（后端控环、N/R/K、模型不编 ID/价格/库存）。不把三个 HTTP 入口做成 ReAct 工具。

### 9.1 根因（为何要换形态）

研究环已经是 Agent native：观察池子 → 模型只做 keep / 改写 / TopK → 环境否决非法输出。

外层话轮仍是任务型对话（TOD）：

```text
句子 → 收成 DialogueAct.kind → plan_route(kind) → 节点副作用
```

开放需求不是封闭言语行为集合里的一个标签，而是对当前世界（约束账本、工作集、事件）提出的请求。先压成 `undo|refine|stance|…` 再查表执行，识别和生效必然脱节。

撤销词表是这个模型露得最明显的地方：

| 症状 | 根因实例 |
|---|---|
| 「我反悔了」撤不掉 | **动作**（回滚账本）被做成 **词类**（四段正则） |
| 图里标了 `undo` 也不撤 | 识别在图内，唯一执行器在命令层，没有工具语义 |
| ground 用句式盖模型 kind | 阶段 1 已收：ground 只绑槽与 ID |
| 对不上 topic 就概述第一件 | 回复跟 kind 走，不跟用户问题走 |
| 三入口当 ReAct 工具会漂 | 把 **通道** 误当成 **世界动作** |

因此：不是「再让模型在门口做一次意图分类」，而是 **口语回合不再以 kind 为中枢，改以对世界的工具调用为中枢**。侧栏 PATCH、撤销按钮仍是通道，不进解释器。

### 9.2 两股分流

```text
用户做了一下
        │
        ├─ 控件已经自报身份 ────────────── 通道
        │    侧栏改预算 / 点撤销 / 改比较集
        │    不经模型，直达现有执行器
        │
        └─ 只有一句原文 ────────────────── 口语
             观察世界 → 一次 JSON → 环境按工具执行 → persist
```

| | 通道 | 口语 |
|---|---|---|
| 输入 | 已填好的字段 / `command=undo` | 一句原文 |
| 是否经模型 | 否 | 是（一次 TurnDecision） |
| 执行器 | 与口语 **同一张工具表** | 同一张工具表 |

通道负责少一次识别；口语负责开放说法也能打到同一执行器。不是两套账本。

| 控件 | 现行 | 目标形态 |
|---|---|---|
| 侧栏预算 2500 | `PATCH /constraints` → `update_constraints` | 仍是这条，内部叫 `apply_patch` |
| 点「撤销」 | `command=undo` → `undo()` | 仍是这条，内部叫 `undo_constraints` |
| 改比较集 | `PUT /comparison`，不派 Agent | 仍不派 Agent |

打字「预算 2500」若模型选出 `apply_patch`，和侧栏走同一个合并、同一条 `constraints.updated`、同一套版本规则。打字「我反悔了」若选出 `undo_constraints`，和按钮走同一个 `undo()`。

### 9.3 口语：观察（只读世界）

模型决策前只拿投影，不能 dump 全库、不能直接改 mission。

| 看见什么 | 用来干什么 | 不看见什么 |
|---|---|---|
| 本句原文 | 唯一的开放输入 | 全程聊天记录 |
| `TurnView`：当前 query/预算、DST、上一来一回、焦点、比较集、对照前三 | 指代和态度 | listing key、全量 ranked |
| `WorkingSet`：pool / display / mentioned | 「那个白色」绑到哪件 | 不在工作集里的历史商品 |
| 环境标志，例如 `can_undo: true/false` | 能不能调撤销 | `before` 里的完整旧约束（执行器自己去事件里取） |
| 可选：`pending_ops` | 上一轮没做完的 | 研究沙箱内部的检索轨迹 |

`can_undo` 由规则算：倒扫事件，有没有带 query 的 `constraints.updated`。模型只看到布尔值，不能自己编一笔 before。

与现行差别：现在分类也能看到 TurnView，但看不到「能不能撤」，也不要求决策必须落成工具。

### 9.4 口语：一次 JSON（模型为主）

整句只做一次结构化决策，不在这里 while 循环点工具。

```text
TurnDecision
  ops: [     // 1～3 个，按顺序执行
    { tool, ...参数 }
  ]
  leftover: [ ]   // 本轮故意不做的，写入 pending，下轮观察还能看见
```

`DialogueAct.kind` 降为兼容投影，不再是路由主轴。`TurnPlan` 已朝「一轮多个 op」走了一半；目标是 op 必须是可执行工具，不是再分类一次的标签。

示例：

「我反悔了」（观察里 `can_undo=true`）：

```json
{ "ops": [{ "tool": "undo_constraints" }] }
```

「预算改成 2500，不要这款」（焦点在工作集里）：

```json
{
  "ops": [
    { "tool": "apply_patch", "budget_cny": 2500 },
    { "tool": "reject_items", "snapshot_ids": ["<focus>"] }
  ]
}
```

「帮我比前两个，顺便不要入耳」：

```json
{
  "ops": [
    { "tool": "compare", "snapshot_ids": ["id1", "id2"] },
    { "tool": "apply_patch", "exclude_terms": ["入耳"] }
  ]
}
```

词表可留作快捷键：「撤销」两字直接合成 `{ tool: undo_constraints }`，省一次调用。不是主分类器。

模型失败或无 Key：用现有句式拼一个尽量合法的 `TurnDecision`，**仍进同一张工具表**，不走「kind → 另一套 merge/route」。

### 9.5 口语：环境执行器（规则为辅）

按 `ops` 顺序：校验闸门 → 执行 → `OpResult`。失败则停下或跳过，写入 warnings，不假装成功。

| 工具 | 世界效果 | 环境硬闸 |
|---|---|---|
| `undo_constraints` | 调现有 `undo()` | 没有带 query 的 `constraints.updated` → `NothingToUndo` |
| `apply_patch` | 合并约束，发 `constraints.updated` | 市场枚举、预算范围、sanitize |
| `reject_items` | 否定 listing / 排除词 | ID 必须在 WorkingSet |
| `ask_about` | grounded 问答 | 只收 `CitedFacts`；缺字段必须说没有 |
| `compare` | 2–4 件对比 | ID 在工作集，数量 2–4 |
| `refilter` / `rerank` | 本地滤/排 | reuse_key 对不上则拒绝，改走 `research` |
| `research` | 现有研究环 | 无 query 拒绝；环内 N/R/K 不变 |
| `probe` | 升格一条追问 | 只能从封闭 `SlotId` 挑；直邮/保修/评分不可问 |

写死在执行器、不进提示词当软约束：

1. 一回合最多一个 `research`。
2. `undo_constraints` 与 `apply_patch` 互斥；undo 成功则丢掉同句里的 patch。
3. 指代先由规则绑到 WorkingSet；绑不上就失败或转澄清，不默认第一件。
4. 工具失败必须是失败，不能静默改成「再介绍首选」。

`execute` 内部仍复用现行节点：`research` 仍是后端控环，`refilter` 仍是 `run_filter`。变的是谁决定调用它们。

图从五条条件边收成：

```text
receive → decide → execute_ops → persist
```

五边留作 execute 内部实现，不再是用户句的主分类。persist 仍是唯一写库。

---

## 10. 现行 vs 目标：对照与分析

### 10.1 链路对照

```text
现行（口语）
  词表？──命中──► undo() ──► 再派 run（skip 理解）
      └──未命中► message.received
                    → parse_turn / 句式 / ground   ← 多套解释器
                    → kind
                    → plan_route(kind)             ← 查表
                    → talk | refilter | research
                    → persist
                    （kind=undo 也不调用 undo()）

目标（口语）
  快捷词表？（可选，直接合成 ops）
      └──否则► 观察世界
                → 一次 TurnDecision.ops
                → 同一张工具表按序执行          ← 识别和生效同一处
                → persist
```

| | 现行口语 | 目标口语 |
|---|---|---|
| 中枢 | `DialogueAct.kind` | `TurnDecision.ops`（世界动作） |
| 解释器 | 入口正则 + frames + `parse_turn` + ground 盖 kind | 快捷词表 + 一次 JSON |
| 撤销 | 词表独占；漏了当选物句；图内 undo 不回滚 | 模型可选 `undo_constraints`，与按钮同一 `undo()` |
| 路由 | `kind` 查五边 | 执行 `ops`；五边是工具实现 |
| 并列句 | 模型出完整 ops（阶段 1）；规则只在失败时拆 | 模型出完整 ops；规则校验、绑 ID、截数量 |
| 失败 | 常静默改成 talk / 概述第一件 | 显式失败（`NothingToUndo`、绑不上） |
| PATCH / 按钮 | 已是通道直达 | 保持；与口语共享执行器 |

「模型为主、规则为辅」落在两处：

- **为主**：开放句子怎么变成 `ops`（唯一需要理解的地方）。
- **为辅**：通道要不要进解释器、工具能不能调、ID/预算/版本怎么落地、失败如何暴露。

### 10.2 为何不是「三入口 = 三工具的 ReAct」

| | 三入口当 ReAct 工具 | 本目标形态 |
|---|---|---|
| PATCH / 按钮 | 再让模型猜已经确定的通道 | 通道直达，不经模型 |
| 「预算 2500」 | 门口 patch 和图内 merge 抢版本 | 口语统一 `apply_patch`，与侧栏同一执行器 |
| 「我反悔了」 | 可能和 reject 连打、版本连跳 | 一次决策；undo 与 patch 互斥 |
| 研究环 | 容易被外层再套一层自由循环 | 仍是后端控环，只被 `research` 工具调用 |
| 无 Key | 整扇门挂掉 | 快捷词表 + 同一工具表降级 |

Agent native 不是到处 ReAct，是 **开放输入只进一个决策点，封闭保证全在环境**。研究环已经证明这条；外层应对齐，而不是再造分类状态机。

### 10.3 例句怎么跑

**点撤销**  
通道 → `undo_constraints` → persist。没有观察、没有 JSON。

**打字「我反悔了」**  
观察：`can_undo=true`。决策：`[{ tool: "undo_constraints" }]`。执行：与按钮同一 `undo()`。persist：`constraints.undo` + 按恢复后的约束重算。词表没命中也不再当「介绍第一件」——只要模型选出这个工具，账本就会动。

**打字「帮我比前两个，不要入耳」**  
决策：compare 两件 + patch 排除「入耳」。执行：先对比；排除若 reuse 仍成立则 `refilter`，否则留下轮 `research`。现行则常常只做 lead（多半 compare），排除留在 leftover 不一定落地。

**侧栏改预算 2500**  
通道 → `apply_patch` → 派一趟只做 refilter/research → persist。与口语「预算 2500」最终同一工具，只是口语多一次决策。

### 10.4 分阶段（先补执行，再拆 kind）

不变量继续成立：目录归工具；persist 唯一写库；检索不是默认路径；研究环不退回自由 ReAct；问句必须能兑现。

| 阶段 | 做什么 | 验收 |
|---|---|---|
| 0 | `parse_turn` 标了 `undo` 则 `bind_turn_actions` 调用与按钮同一 `find_restorable_constraints`；词表仍作命令层短路 | 「我反悔了 / 回到上一档」真的回滚（已落地：`turn_actions` + 图节点） |
| 1 | 口语只留：快捷词表 → `parse_decision` / `propose_plan` → bind；ground 只绑槽与 ID，不再改 kind；全部 ops 生效 | 四套解释器不再争一句（已落地：`decide_oral` + `parse_decision`） |
| 2 | 图变成 `receive → decide → execute_ops → persist`；五边留在 execute 内 | kind 不再查表得边（已落地：`route_after_world` + `execute_ops`） |
| 3 | `ask_about` 跟问题 + CitedFacts 走；ready 句与 draft 打通；probe 从封闭 SlotId 里由模型挑 | 对不上 topic 不再默认概述第一件（已落地：`_unanswerable_reply` + `compose_ready_reply(draft=)` + `choose_probe`） |

建议先做阶段 0。不要先改研究环，也不要在门口上 ReAct。

### 10.5 和 §7 拍板表的关系

§7 的 A–H 仍是「在现行图上局部改成模型为主」的对照。若采用 §9 目标形态，优先级收成：

| 先做 | 对应 | 为什么 |
|---|---|---|
| 阶段 0 撤销接到执行器 | 开放控制意图、漏了无补救 | 识别和生效必须同一处 |
| 阶段 1 单一决策点 | C、H | 不再句式盖 kind、模型出完整 ops |
| 阶段 2 工具执行替代 kind 路由 | E | 走错支路的根在查表 |
| 阶段 3 问与答跟问题走 | A、B、D | 模板答非所问、probe 错位 |

G（refilter 词表与 keep 对齐）、研究环三次 JSON、硬过滤 / FX / 落库 / 通道分流：保持，不在本重构里推翻。
