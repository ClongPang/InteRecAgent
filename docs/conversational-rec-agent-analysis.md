# 对话式推荐 Agent 调研与当前项目优劣分析

**日期**：2026-08-19
**项目**：InteRecAgent · 跨境选物台
**文档类型**：调研 + 架构评估
**范围**：对话式推荐 Agent 领域现状调研，并对照本项目实现逐维核对与优劣分析。结论对应代码为 2026-08-19 主干状态。

---

## 1. 领域调研：对话式推荐 Agent 现状

### 1.1 范式演进

对话式推荐已从「静态排序管线」转向「自主 Agent」。综述层面（[Agentic Recommender Systems Roadmap](https://arxiv.org/html/2607.04433v1)、[A Survey on LLM-powered Agents for Recommender Systems, EMNLP 2025](https://aclanthology.org/2025.findings-emnlp.620/)）把该领域归为三种范式：

| 范式 | 角色 | 说明 |
|---|---|---|
| Agent-assisted（推荐器导向） | LLM 增强检索/排序 | 强化传统推荐核心机制 |
| Agent-as-recommender（交互导向） | LLM 主导多轮对话 | 追问偏好、生成可解释推荐（**本项目属于这一类**） |
| Agent-as-user-simulator（仿真导向） | 多 Agent 模拟用户 | 用于数据生成与评测 |

综述统一用**四模块 Agent 架构**剖析：`Profile（画像）/ Memory（记忆）/ Planning（规划）/ Action（工具动作）`。

### 1.2 代表性学术架构

- **InteRecAgent（微软，本仓库同名）** — [论文](http://arxiv.org/pdf/2308.16505v2) / [ACM TOIS](https://dl.acm.org/doi/10.1145/3731446)
  - 思路：**LLM 当「大脑」，传统推荐模型当「工具」**。工具分三类：`query / retrieval / ranking`。
  - 关键组件：**Shared Candidate Bus**（工具间传递候选，避免 prompt 塞满 item 名）、**长短期用户画像**、**Plan-first + 动态示例增强规划 + Reflection**。
- **RecMind** — [NAACL 2024 Findings](https://aclanthology.org/2024.findings-naacl.271.pdf)
  - Planning + Memory + Tools（database SQL / search / summarization）；亮点是 **Self-Inspiring** 回溯历史状态改进规划。
- **HARPO（ACL 2026）** — [论文](https://aclanthology.org/2026.acl-long.1646/)
  - 批判只优化 Recall@K/BLEU 等代理指标；方案是分层偏好学习 + 价值网络引导的**树搜索审议推理** + 多 Agent 精修。

### 1.3 商业化落地（购物场景）

- **Amazon**：2026-05 把 Rufus 并入 [Alexa for Shopping](https://www.aboutamazon.com/news/retail/alexa-for-shopping-ai-assistant)，支持产品问答、并排比较、价格追踪、到目标价自动购买、跨站购物（Buy for Me）；同时**封堵第三方 Agent**（法院一度禁止 Perplexity Comet 在 Amazon 代购）。
- **OpenAI / Google / Perplexity**：均上线购物研究/Agent；Google 支持对话内结账，OpenAI 因未获牵引于 2026-03 **撤回 in-chat checkout**。
- **关键信号**：「研究 + 比价」是已验证刚需；「代客下单/结账」的信任与商业博弈**尚未跑通**。这印证本项目「只做研究员/决策助手、不做代购下单」的边界是务实的。

### 1.4 评测基准

- 对话推荐数据集：ReDial、INSPIRED、MUSE。
- Agent 工具/策略遵循：τ-Bench、τ²-Bench（[LLM Agent 评测综述](https://arxiv.org/html/2503.16416v2)）。
- 长期记忆：LoCoMo（趋近饱和）、LongMemEval、BEAM（[State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)）。
- 趋势：从代理指标转向 **LLM-as-judge + 仿真评测 + Agent 专属指标（规划、工具使用、效率、可信度）**。

### 1.5 共性挑战

成本/推理效率、工具循环失控、幻觉与事实绑定、跨会话身份识别、记忆陈旧、静态基准召回 ≠ 真实任务表现、安全（prompt 注入、密钥泄露）。

---

## 2. 当前项目五维核对

领域主流架构可归纳为：**LLM 编排 + 工具化推荐 + 记忆/画像 + 规划反思 + 证据可追溯**。逐项核对本项目实现：

| 维度 | 结论 | 说明 |
|---|---|---|
| LLM 编排 | 名义满足，定位不同 | 编排主体是 LangGraph 确定性图，LLM 只在 2 个节点做受约束增强 |
| 工具化推荐 | 满足 | Port/Adapter 工具化清晰，但工具是静态图节点，非 LLM function-calling |
| 记忆/画像 | 部分满足 | 任务内工作记忆完善；跨任务长期用户画像缺失（PRD P1） |
| 规划反思 | 部分满足 | 规划有（确定性）；反思只有「校验 + 降级」，无自我反思重规划闭环 |
| 证据可追溯 | 强满足 | 全链路快照 + ID 校验 + 引用 + 事件溯源，项目最强一环 |

**核心差异**：本项目是「**确定性状态图编排 + LLM 受约束增强**」，而非学术界的「LLM 自主编排 + 动态 tool-use」。这是有意的安全取舍（符合 PRD 7.2、spec AGT-003/004）。

### 2.1 LLM 编排 — 名义满足，实为「图编排」

编排大脑是确定性状态图（`backend/agent/graph.py`），LLM 只在 `classify_dialogue_act`（`parse_turn`/`parse_intent`）与 `compose_recommendation`（`draft_recommendation`）两处参与，且均可降级为确定性 fallback。`ModelBackend` Port 约束「只允许输出结构化 DTO，不得直接输出价格/库存/链接」。

### 2.2 工具化推荐 — 满足

工具经 Port 注入（`ProductSource`/`FxSource`/`UnitOfWork`），对应 retrieval（`fetch_products`）+ 汇率（`fetch_fx`）+ ranking（`score_and_rank`）。差距：工具编排为静态图，非动态 tool-use；且缺 InteRecAgent 式的 SQL/query 灵活工具，检索只走 `search`。

### 2.3 记忆/画像 — 任务内有，跨任务缺

任务内工作记忆完整：`PreferenceBelief`（软偏好/拒绝项/价格态度）、`DialogueState`（指称）、`candidate_set` 缓存（≈ shared candidate bus）。差距：`belief` 挂在单个 mission 上（匿名任务），**无用户级跨任务 long-term profile**（PRD P1）。

### 2.4 规划反思 — 规划有，反思弱

规划为确定性（`plan_search` / `plan_route` / `next_moves_for`）。反思只有「校验 + 降级」：`compose_recommendation` 过滤 LLM 幻觉 ID、fx/市场失败降级。**无 Self-Inspiring / 树搜索**；PRD 6.7「无结果放宽软条件重搜」未实现——无候选直接 `DEGRADED`。

### 2.5 证据可追溯 — 强满足（最强项）

`verify_evidence` 只引用 ranked 中存在的事实；`persist_decision_snapshot` 落地商品快照（`raw_payload` + `contract_version`）、汇率快照、候选集、recommendation_run，并写带 `citations`/`snapshot_ids` 的事件流。达到 PRD「字段可追溯率 100%」目标。

---

## 3. 架构取舍：为什么选静态图而非 LLM 动态 tool-use

依据 `docs/technical-architecture-and-selection.md` §2 与 `spec` AGT 约束，这是**有意决策**：

1. **购物任务难点是「维护状态」而非「生成观点」**——约束/候选/证据/版本需持续一致，动态 tool-use 每轮重新决策会让状态维护失控。
2. **高风险事实必须走确定性代码**（AGT-003/004）——价格、库存、汇率、硬过滤错了就误导用户；静态图把「必须换算、必须过滤、必须校验证据」变成不可绕过的边。
3. **增量重算**——`research / refilter / rerank / talk` 分路径，改预算只走 refilter、改措辞只走 talk，满足延迟与「避免无控制工具循环」要求。
4. **可复现、可测试、可审计**——图结构可做快照测试，覆盖六种降级场景；动态轨迹难做确定性回归。
5. **无 Key 可运行**（DEC-004 / AGT-006）——编排不依赖 LLM，无 Key 时确定性 fallback 仍可验收。

---

## 4. 优势（这套方案做对了什么）

| 优势 | 依据 |
|---|---|
| **事实零幻觉** | 价格/库存/汇率来自工具与快照，LLM 只输出结构化 DTO 且二次校验 ID（AGT-003/004、AC-009） |
| **证据全链路可追溯** | 快照 + 引用 ID + 事件溯源；本项目最强项 |
| **可复现、可测试** | 确定性图 + 快照测试覆盖正常/追问/无结果/FX 失败/部分市场失败/superseded |
| **低延迟、低成本** | 最小重算路由，避免无控制工具循环 |
| **无 Key 可运行** | 确定性 fallback 支撑完整闭环验收 |
| **强降级能力** | FX 失败保留原币、部分市场失败仍出候选、旧版本 superseded 不覆盖新版本 |
| **清晰边界与依赖方向** | Port/Adapter + 组合根注入，domain 不依赖 api/infra |
| **务实的产品边界** | 只做研究/比价、不做代购下单，与商业教训一致 |

---

## 5. 劣势与风险（这套方案的代价）

### 5.1 意图覆盖是硬编码枚举，长尾需求掉线

`score.py` 的偏好线索词（`NOISE_CUES`/`BATTERY_CUES`）与 `next_move.py` 的品牌清单（`Sony/Bose/Apple/...`）均写死。用户说「防水/轻便/送礼/老人用/游戏低延迟」等不在枚举内的需求，偏好即降级为普通排序。**根本天花板**：意图空间无限，规则表有限；每加品类/偏好都要改代码、加线索词、重测。

### 5.2 无反思重规划，无结果直接降级

`filter → rank → verify` 为单向边、无环。候选为空直接 `DEGRADED`，**不会自主「放宽软约束/换型号/扩市场」再试**（PRD 6.7 未落地）。这是灵活性缺失最痛处。

### 5.3 工具维度单一，做不了多跳/组合研究

`fetch_products` 只走 `search`，详情/比较/价格历史 Adapter 已解析却未进编排。用户问「最近降价了吗/详细规格差异/换个便宜同款」需多工具多跳组合，静态图每加路径就新增节点与边，扩展成本随组合数爆炸。

### 5.4 规则分类器的「假自信」误分类

确定性 `classify_turn` 只在返回 `UNKNOWN` 时才触发 LLM 兜底；若自信地分错（返回错误的非 UNKNOWN 类别）则不复核。混合意图（如「太贵了，但没货就算了」）可能被判成单一意图，漏掉条件。

### 5.5 规则与数据结构耦合，维护脆弱

`next_move.py` 依赖 `ranked` dict 结构与特定字段（`estimated_cny` 需兼容 dict/标量）。数据结构变动牵连多处；线索词/品牌清单随市场扩张膨胀形成「规则债」，与 OCP 初衷相悖。

### 5.6 个性化上限低

排序为通用多目标打分，`belief` 仅任务内。无跨任务画像，**无法学习个体差异**（偏小众品牌/偏轻量/不在乎评分数）。

---

## 6. 演进建议（不破坏外层确定性骨架）

| 问题 | 优先级 | 最小改动 |
|---|---|---|
| 无结果不自救（5.2） | 高（改动最小） | `filter` 空结果时加「放宽软约束重搜」条件边，形成闭环 |
| 意图硬编码（5.1） | 中 | LLM 输出结构化「软偏好维度 + 方向」，`score.py` 按通用维度打分，去掉写死枚举 |
| 多跳研究（5.3） | 中 | 在 `research` 子图**内部**开受限 LLM tool-use 沙盒（白名单 search/detail/price-history，输出回确定性校验） |
| 误分类（5.4） | 中 | 低置信度也走 LLM 复核，而非仅 UNKNOWN |
| 跨任务画像（2.3） | 低（PRD P1） | 将 `PreferenceBelief` 从 mission 级抽到 owner 级 |
| 评测（1.4） | 低 | `tests/eval/dialogues.json` 加「硬约束违反率 / 证据可追溯率」自动断言 |

**核心思路**：外层流程/证据/换算保持确定性不变，把「意图理解」与「探索式研究」两块灵活性需求，收敛到**受控的 LLM 增强点**——既补灵活性，又守住可审计与无 Key 可运行的底线。

---

## 附录：参考资料

- [Autonomous Information Seeking: A Roadmap for Agentic Recommender Systems](https://arxiv.org/html/2607.04433v1)
- [A Survey on LLM-powered Agents for Recommender Systems (EMNLP 2025)](https://aclanthology.org/2025.findings-emnlp.620/)
- [Recommender AI Agent: Integrating LLMs for Interactive Recommendations (InteRecAgent)](http://arxiv.org/pdf/2308.16505v2)
- [RecMind: LLM Powered Agent for Recommendation (NAACL 2024)](https://aclanthology.org/2024.findings-naacl.271.pdf)
- [HARPO (ACL 2026)](https://aclanthology.org/2026.acl-long.1646/)
- [A Survey on Evaluation of LLM-based Agents](https://arxiv.org/html/2503.16416v2)
- [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Alexa for Shopping](https://www.aboutamazon.com/news/retail/alexa-for-shopping-ai-assistant)
- 项目内文档：`docs/cross-border-shopping-agent-prd.md`、`docs/technical-architecture-and-selection.md`、`spec/spec-architecture-project-skeleton.md`
