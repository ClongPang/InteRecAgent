# 研究 tool-use：问题与方案变迁

**版本**：1.1  
**日期**：2026-08-20  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：问题复盘 + 方案取舍  
**范围**：研究子图的控环与工具。记录为什么硬步骤无参，以及为什么改成后端控环而不是自由 ReAct。

本文接 [live-hardening-scheme-evolution.md](./live-hardening-scheme-evolution.md) 里的研究进度与过滤共用。外层对话分类、改约束、写回复**不是** tool-use，走结构化输出，不在本目录；分叉与分类窗口见 [dialogue-route-scheme-evolution.md](./dialogue-route-scheme-evolution.md)。事实层 / 决策层 / 语言层的职责分离不变：模型只编排顺序，不得编造价格、库存、汇率。

---

## 1. 变迁总览

研究节点曾经是线性链：`build_search_plan → fetch → fx → normalize → filter → rank`。后来在子图**内部**开受限 tool-use 沙盒（AGT-001），让模型决定要不要换词重搜、何时结束。风险不是「工具太少」，而是把硬约束做成模型可改的参数。

```text
阶段 0  静态线性链
        图节点顺序写死
        无结果不能自主放宽检索
            │
            ▼
阶段 1  同一套工具，两种驱动
        有 tool-calling → run_agent
        无 Key / 降级 / 安全网 → run_deterministic
        目录焊在 ResearchTools.specs
            │
            ▼
阶段 2  签名收口
        软决策带参：search_products / finalize
        硬步骤无参：convert_fx / filter_candidates / rank_candidates
        读写 ResearchContext，不把商品全量塞进 prompt
            │
            ▼
阶段 3  后端控环（现行）
        检索 → 规则过滤 → 模型 keep → 并入池子
        池子 < 25 且未满 3 次检索 → 改写 query 再搜
        停搜后模型按规则 prompt 选 TopK=6
        再搜覆盖改为 listing key 去重累加
```

| 阶段 | 用户能看见的失败（若退回去） | 根因层级 | 最终落点 |
|---|---|---|---|
| 0 | 空结果直接放弃，不会换词或加市场 | 编排不能重试 | 研究子图内 tool-use |
| 1 | 模型跳过汇率就按人民币筛；未知库存当无货 | 硬约束暴露成参数 | 无参工具 + 流水线内补齐 FX |
| 2 | 每步把整份候选塞进模型，贵、慢、会编 | 上下文与幻觉 | Shared Candidate Bus 只回 ID / brief |
| 3 | 再搜盖掉已滤干净的集合；脏召回靠无限加词 | 环境不累加、法官只在规则层 | 后端控环 + keep 求交 + 池子阈值 |

---

## 2. 当前注册目录

执行器仍在 `ResearchTools`，但**循环不再由模型自由点工具**。`run_research` 按固定顺序调用检索 / 过滤；模型只通过 `complete_json` 做三次单次决定：本轮 `keep`、改写 `query`、从池子选 `ranked`。无 Key 或 JSON 失败则跳过该步，环的形状不变。`supports_tools()` 不再作为研究入口，入口是 `is_configured()`。

| 工具 | 有无参数 | 模型决定什么 | 实际输入从哪来 |
|---|---|---|---|
| `search_products` | 有 | 换什么词、加哪个市场、模式、条数、要不要放宽原币上限 | 缺省用 `ctx.plan`；结果写入 `ctx.products` |
| `convert_fx` | 无 | 现在要不要换算 | `ctx.products`；汇率写入 `ctx.rates` |
| `filter_candidates` | 无 | 现在要不要过滤 | 任务约束 + 信念（排除项、已否定 listing）+ 当前候选 |
| `rank_candidates` | 无 | 现在要不要排序 | 同上；产出 `ctx.ranked` |
| `finalize` | 可选 `reason` | 何时结束研究 | 不改事实；后续 verify / persist |

`search_products` 允许的市场枚举：`US` / `SG` / `VN` / `TH` / `MY`。`mode` 只有 `keyword` / `hybrid`。`skip_budget_cap=true` 只放宽**召回**时的原币上限，人民币预算过滤仍在 `filter_candidates` 里做。

硬门槛写在 `ResearchLimits`：`pool_threshold=25`，`max_searches=3`，`top_k=6`。每轮先并入池子再看 `len(pool)`。模型 keep 只勾已有 ID，没勾到的本轮丢掉；编造 ID 服务端丢弃。改写失败或返回 null 则停搜（有模型时不再偷偷扩市场）；无模型时确定性放宽原币上限或扩到默认市场。TopK 求交失败回退 `run_rank`。

---

## 3. 为什么有些工具没有参数

### 3.1 输入已经在当轮上下文里

`convert_fx` / `filter_candidates` / `rank_candidates` 作用在短生命周期的 `ResearchContext`（Shared Candidate Bus）上：

- 上一工具检索到的商品对象在内存里，不需要模型再传一遍列表。
- 预算、偏好、仅看有货、排除词在 `mission.constraints`。
- 已否定 listing、规格门闩在 `mission.belief`。

模型只要发出工具名，表示「现在做这一步」。工具回给模型的是目录统计和极简 sample（ID、标题、市场、价、库存），不是整份快照。

### 3.2 硬约束不能让模型改

若给过滤、汇率、排序开放参数，模型可以：

| 若做成参数 | 会怎样 |
|---|---|
| 传入 `budget_cny` / `only_in_stock` | 漏抽或改数字，和任务上已生效的约束分叉 |
| 传入商品列表或「只留这些 ID」 | 丢掉未展示的候选，或编造不存在的 ID |
| 传入排序权重 | 绕开信念 / 品类门闩 / 价格态度 |
| 跳过 `convert_fx` 却按人民币筛 | 原币和估算混比 |

因此这些焊在 `services/rec/pipeline.py`。`filter_candidates` 发现尚未换算时，会自己先跑 `convert_fx`，保证「先汇率、再预算」，即使模型把调用顺序叫乱。库存事实判定、排除项、否定 listing 也在流水线内完成，不接受模型覆盖。

### 3.3 参数只留给软决策

| 留给模型的 | 为什么是软的 |
|---|---|
| `search_products.query` / `markets` / `mode` / `limit` | 无结果或过少时换词、加市场、放宽召回，是研究价值所在 |
| `search_products.skip_budget_cap` | 原币上限过窄导致空召回时放宽检索；硬预算仍在过滤步 |
| `finalize.reason` | 宣布结束；可选一句原因，不进事实层 |

控制器决定何时检索与停搜。模型不再点工具，只回答 keep / 新 query / ranked ID。价格、库存、汇率仍由工具返回。

---

## 4. 否决过的签法

| 方案 | 主张 | 否决原因 |
|---|---|---|
| 五个工具都带全量参数 | 模型更灵活 | 硬约束会和任务状态分叉；无法审计 |
| 只暴露一个 `research` 工具 | 签名简单 | 无法在空集时单独重搜，也无法复用确定性驱动的逐步执行 |
| 每步把 ranked 全文塞进 tool result | 模型看得清 | 成本、延迟、幻觉；见工作记忆里的 CatalogStats 切片 |
| 让模型代替规则过滤器 | 少写过滤器 | 贵、慢、会编；品类门闩必须先在 `run_filter`。现行是规则之后再 keep 求交 |
| 无 Key 时另写一套线性函数 | 实现快 | 两套流水线会漂移；现行是同一执行器、两种驱动 |

确定性安全网：无模型走同一条 `run_research`，跳过三次 JSON。模型某步失败则该步跳过（keep 失败=本轮规则结果全部并入；TopK 失败=`run_rank`）。运行已过期（`version_probe`）则不补全。

---

## 5. 文件对照

| 职责 | 文件 |
|---|---|
| 后端控环 | `backend/agent/loop.py` |
| keep / 改写 / TopK JSON | `backend/agent/judges.py` |
| 累加池与 ID 求交 | `backend/agent/pool.py` |
| 工具签名与执行器 | `backend/agent/tools/catalog.py` |
| 当轮候选总线 / 门槛 | `backend/agent/tools/context.py` |
| 研究节点挂载 | `backend/agent/nodes/research.py` |
| 硬过滤 / 汇率 / 排序流水线 | `backend/application/services/rec/pipeline.py` |
| 单次 JSON 补全 | `backend/application/ports/model_backend.py` `complete_json` |

副作用只在确定性 persist（commit gate）发生。工具本身不写库。

---

## 6. 以后不要退回去的几条

1. **硬步骤无参。** 不要给 `convert_fx` / `filter_candidates` / `rank_candidates` 加预算、库存或商品列表参数，让模型「更灵活」。  
2. **FX 先于预算。** 过滤工具必须能自己补齐换算；不要假设模型会按提示顺序调用。  
3. **同一套执行器。** 动态循环和确定性安全网必须走 `ResearchTools.run`，禁止再写一条平行流水线。  
4. **候选对象留在 Context。** 回给模型的只是统计和 brief，不是全量 snapshot。  
5. **对话 NLU 不要混进这个目录。** 分类和改约束不是研究工具。
6. **再搜必须并入，禁止覆盖池子。** 停搜看累计件数，不看本轮件数。
7. **模型过滤是 keep 求交。** 不能把规则已删的救回来；失败则跳过，不能卡住 run。
8. **TopK 只能点池内 ID。** 漏抽不补，编造不算。失败回退规则排序。

下一轮若要加 `get_product_detail` 或价格历史，先问：这是软决策（带参）还是硬步骤（无参、读 Context）。并对照 [working-memory-scheme-evolution.md](./working-memory-scheme-evolution.md) 的视图切片约束，以及 [dialogue-route-scheme-evolution.md](./dialogue-route-scheme-evolution.md)：研究 messages 只属于当轮工具循环，不要把用户历史拼进来。
