# 话轮路由与模型窗口：问题与方案变迁

**版本**：1.0  
**日期**：2026-08-20  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：问题复盘 + 方案取舍  
**范围**：每一趟 run 怎么分叉，以及有模型时分类 / 研究 / 起草各自看见什么。不改工具签名（见研究 tool-use 文档）。

本文接 [working-memory-scheme-evolution.md](./working-memory-scheme-evolution.md) 的三角色视图。那里收束「模型只收投影」。这里收束**投影之后怎么选支路**，以及**投影不是聊天历史**。事实层 / 决策层 / 语言层的职责分离不变。

---

## 1. 变迁总览

用户一句话只产生事件和一趟 run。图从 `START` 进、`END` 出，但 **`route_turn` 之后只走一条支路**。研究子图不是默认路径。

```text
阶段 0  每句都检索
        问保修也打 BuyWhere
            │
            ▼
阶段 1  言语行为 + 路由
        classify → effects → merge → route
        talk / clarify / rerank / refilter / research
            │
            ▼
阶段 2  模型窗口收口（现行）
        分类：单次 JSON + TurnView，不是 transcript
        研究：当轮工具 messages，看不见用户历史
        talk：确定性 grounded 回复，模型不写话
```

| 阶段 | 用户能看见的失败（若退回去） | 根因层级 | 最终落点 |
|---|---|---|---|
| 0 | 「这款保修吗」等十几秒再出同一列表 | 每句 research | 按 kind 分叉 |
| 1 | 改预算仍用旧召回，或「太贵了」被当成换品类 | 复用键 / 态度 vs 约束 | `plan_route` + `search_reuse_key` |
| 2 | 把全程对话塞进分类器，贵、指代漂、编造 | 上下文形态 | 邻接对 + DST，禁止 messages 跨轮堆积 |

---

## 2. 一趟 run 并不走完整张图

前半段几乎每趟都跑：

```text
START → receive_message → classify_dialogue_act
      → apply_turn_effects → merge_mission_state → route_turn
```

`receive_message` 绑定本 run 的触发事件：优先 `message.received`；PATCH / undo 只有约束事件，设 `skip_intent_patch`，跳过自然语言分类。

`route_turn` 之后五选一：

```text
route_turn
   ├─ clarify   → persist → END
   │              没品类，只追问
   ├─ talk      → 读缓存 → compose_grounded_reply → persist → END
   │              保修 / 为什么选它 / 对比，不动商品源
   ├─ rerank    → 读缓存 → rank → verify → compose_recommendation → persist → END
   │              态度（太贵了），硬预算不动
   ├─ refilter  → 读缓存 → filter → rank → verify → compose_recommendation → persist → END
   │              排除这款、仅看有货；检索键没变
   └─ research  → 研究子图（5 个 tool）→ verify → compose_recommendation → persist → END
                  换品类、改预算、首次检索、缓存对不上
```

「不要这款」不打 BuyWhere。「这款保修吗」连过滤排序都跳过。只有需要新候选时才进 `research`，也只有那时才有 tool-use。

撤销在进图前由命令层拦截（`is_undo_text`），恢复约束后再派一趟 run，多半走 `refilter` 或 `research`。

关键文件：`backend/agent/graph.py`、`backend/application/services/route.py`、`backend/agent/nodes/fetch.py`。

---

## 3. 意图分叉：先 kind，再开关

路由不是打分。`plan_route` 按顺序命中即返回。

### 3.1 第一步：这句话是什么

有模型且已配置：`parse_turn` 出 `DialogueAct`，再 `ground_dialogue_act` 纠偏。模型不可用则整段退回 `classify_turn`。

| kind | 典型原话 |
|---|---|
| `ASK_ITEM` | 保修吗 / 为什么选它 / 有货吗 |
| `COMPARE` | 帮我比前两个 |
| `META` | 你能做什么 |
| `REJECT` | 不要这款 / 不要索尼 |
| `STANCE` | 太贵了 / 再便宜一点 |
| `REFINE` | 通勤降噪耳机，预算 4000 / 改找显示器 |
| `UNKNOWN` | 空句、收不出品类 |
| `UNDO` | 撤销刚才的条件（进图前处理） |

grounding 要处理两类失败：kind 错了（态度收成 refine）；kind 对但槽空了（`express_stance` 且 `stance=null`）；问句模板吸走约束（「只看有货」收成问库存）。

### 3.2 第二步：四个事实

| 开关 | 含义 |
|---|---|
| `has_query` | 合并后的约束里有没有检索词 |
| `has_cache` | 当前任务有没有候选集 |
| `reuse_matches` | 检索复用键是否等于缓存里那份 |
| `constraints_changed` | 合并后约束是否相对本轮之前有变化 |

复用键只比 **query + 市场 + 预算**（`search_reuse_key`）。偏好、仅看有货、排除词变了，旧召回还能用。换品类或改预算，原币 `max_price` 对不上，必须重搜。

PATCH / undo 另带 `skip_intent_patch`：不再从这句话抽增量，只看恢复后的约束和缓存。

### 3.3 `plan_route` 判定顺序

```text
META / ASK_ITEM / COMPARE
        → talk

STANCE（硬预算没被这句改掉）
        有缓存 → rerank
        无缓存、有品类 → talk
        无缓存、没品类 → clarify

REJECT
        有缓存 → refilter
        没缓存、有品类 → research
        没缓存、没品类 → clarify

还没有 query
        → clarify

PATCH / undo（skip_intent_patch）
        缓存能复用 → refilter
        否则 → research

REFINE
        缓存能复用、约束没变 → talk
        缓存能复用、约束变了（如仅看有货）→ refilter
        缓存不能复用（换品类或改预算）→ research
```

图节点额外一刀：`STANCE` 且 `want_lighter`（快照无重量）强制 `talk`，避免空排序。

若命令层已写入 `decided_route`，`route_turn` 尊重它。

### 3.4 对照

| 用户说 | kind | 支路 | 原因 |
|---|---|---|---|
| 这款保修吗 | ASK_ITEM | talk | 只问答 |
| 太贵了（已有列表） | STANCE | rerank | 态度入信念 |
| 不要这款 | REJECT | refilter | 现有列表硬丢 |
| 只看有货 | REFINE | refilter | 检索键没变 |
| 预算改成 2000 | REFINE | research | 预算在复用键里 |
| 改找 4K 显示器 | REFINE | research | query 变了 |
| 帮我买个东西 | UNKNOWN | clarify | 还没有品类 |

---

## 4. 有模型时：单次完成，不是聊天历史

跨轮靠任务上的约束和信念，不靠把 transcript 传给模型。三种模型调用形态不同，都**不是**「带着全部历史做多轮问答」。

### 4.1 分类：`parse_turn`

一次 `_complete_json`：系统提示 + **一条** user。user 里是当前检索词、用户这一句，以及 `TurnView` 压成的「上下文」JSON：

- `dst`：用途、规格门闩名、价格态度、待填槽、最近排除原因、已排除件数
- `last_user` / `last_agent`：邻接对（事件里最后一条用户、最后一条助手，助手截 180 字）
- `last_act`、抽屉 `focus` brief、比较集 brief、ranked 前三 brief

不传：全程对话数组、`rejected_listing_keys`、全量 critiques、全量 ranked。`recent_user_texts` 实际只有邻接对里那一条，不是最近 N 轮。

模型只输出一个 `DialogueAct` JSON。禁止输出价格、库存、链接、汇率。失败或 Schema 不过则当模型不可用，改走确定性分类。

### 4.2 研究：三次单次 JSON，不是工具聊天

仅 `research` 支路。后端控环，模型最多三次 `complete_json`：本轮 keep、改写 query、从累加池选 TopK。每次都是系统提示 + 一条 user JSON，看不到用户聊天历史，也看不到「上一句不要索尼」。候选对象在 `ResearchContext.pool`，回给模型的是 ID + brief。详见 [research-tool-use-scheme-evolution.md](./research-tool-use-scheme-evolution.md)。

### 4.3 起草：`draft_recommendation`

又是单次 JSON：约束 + `draft_candidates`（主推 / 两备选 / 比较集）+ 确定性草稿。所有 ID 必须来自输入。失败保留确定性稿。

### 4.4 talk：模型不写回复

`compose_grounded_reply` 用快照事实拼句子（保修未知、库存来源、为什么排在这）。不把用户历史交给模型生成。

### 4.5 否决过的窗口

| 方案 | 主张 | 否决原因 |
|---|---|---|
| 把 thread 全量当 chat messages | 「模型有记忆」 | 指代锚点被散文稀释；贵；会编造未出现的商品 |
| 会话摘要器再喂分类器 | 任意长度 | 见工作记忆文档；摘要会丢比较集和否定对象 |
| 分类也走 tool-use 多轮 | 和研究统一 | 分类必须快、可 ground；多轮会拖死 talk/clarify |
| talk 也让模型写话 | 更自然 | 保修/库存会编；与「语言层不得发明事实」冲突 |

---

## 5. 文件对照

| 职责 | 文件 |
|---|---|
| 图边与分叉 | `backend/agent/graph.py` |
| `plan_route` / 复用键 | `backend/application/services/route.py`、`nlu.py` `search_reuse_key` |
| 分类节点 / grounded 回复 | `backend/agent/nodes/dialogue.py` |
| 触发事件绑定 | `backend/agent/nodes/fetch.py` |
| 投影窗口 | `backend/application/services/model_context.py` |
| `parse_turn` / 起草 | `backend/infrastructure/llm/openai_compat.py` |
| grounding | `backend/application/services/nlu.py` `ground_dialogue_act` |

测试：`tests/test_dialogue.py`（`plan_route`、复用键）、`tests/test_model_context.py`、`tests/eval/dialogues.json`。

---

## 6. 以后不要退回去的几条

1. **研究不是默认路径。** 不要为了实现简单让每句话都进 `research`。  
2. **态度重排，排除过滤，品类/预算重搜。** 不要把「太贵了」收成改 query，也不要在预算放宽时复用旧召回。  
3. **分类是单次 JSON + 投影，不是 chat 历史。** 不要把 `thread.messages` 编进 `parse_turn`。  
4. **研究 JSON 只属于当轮控环。** 不要把上一轮用户原话拼进 keep / 改写 / TopK 的 user payload。  
5. **talk 不交给模型写事实句。** 保修、库存、价格只引用快照。

下一轮若要加「多轮澄清对话」，先扩 DST 槽和邻接对，不要先上 transcript。并回看 [working-memory-scheme-evolution.md](./working-memory-scheme-evolution.md) 的视图切片约束。
