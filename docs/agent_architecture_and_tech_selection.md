# InteRecAgent Agent 架构与技术选型说明

## 1. 文档目的

本文档从 **AI Agent 开发架构师** 与 **传统产品开发架构师** 的双重视角，对 InteRecAgent 的系统定位、架构边界、技术选型和工程难点进行说明。

InteRecAgent 当前不应被设计成完全自主的购物 Agent，也不应被设计成纯规则推荐系统。更合理的定位是：

> **受控型 Agentic Workflow + 传统推荐系统 + 可观测评估 Harness。**

它的核心目标是：在可控的业务流程中引入 AI 的语义理解、澄清决策、反馈归因和自然语言生成能力，同时用传统系统保证商品事实、约束校验、排序可解释性、日志可追踪和评估可复现。

---

## 2. Workflow、Agent 与 Autonomous Agent 的边界

### 2.1 三种系统形态

| 形态 | 特征 | 优点 | 风险 | 与 InteRecAgent 的关系 |
|---|---|---|---|---|
| 纯 Workflow | 流程固定，规则驱动，分支明确 | 稳定、可测、可控 | 难处理模糊输入和复杂意图 | 作为系统骨架 |
| Agentic Workflow | 主流程固定，关键节点由 AI 做语义判断 | 兼顾智能与可控 | 需要明确 AI 与系统边界 | 当前推荐形态 |
| Autonomous Agent | 模型自主规划步骤、选择工具、循环执行 | 灵活、探索性强 | 不稳定、难评估、易失控 | 不作为 MVP 目标 |

InteRecAgent 应采用 **Workflow-first Agent**：

```text
固定主流程：
Task Router
  -> Intent Parser
  -> Session State / User Profile
  -> Clarification Policy
  -> Retriever
  -> Constraint Verifier
  -> Rule Ranker
  -> LLM Reranker
  -> Response Generator
  -> Feedback Updater
  -> Trace Logger
```

其中部分节点由 AI 增强，但流程本身不交给模型自由决定。

### 2.2 边界定义

一句话定义：

> **系统决定流程边界，AI 决定局部语义判断。**

Workflow 负责“必须发生什么”：

- 必须识别任务类型。
- 必须维护 `IntentState`。
- 必须从商品库召回候选。
- 必须做约束校验。
- 必须记录 trace。
- 必须在 LLM rerank 后做 final validation。
- 必须有澄清轮数保护。
- 必须输出结构化结果。

Agent 负责“如何理解和选择”：

- 用户输入属于什么任务。
- “别太贵”“适合通勤”“给妈妈买”这类模糊语义如何理解。
- 当前缺失信息是否值得追问。
- 应该问哪个澄清问题。
- 用户负反馈到底指向品牌、价格、功能还是外观。
- 候选商品中哪个更符合用户当前意图。
- 如何生成自然语言解释。

---

## 3. AI Agent 与传统系统的责任划分

### 3.1 总体原则

> **Agent 做语义判断，传统系统管事实与约束。**

AI Agent 不应该直接决定商品事实，也不应该绕过传统推荐系统的硬约束校验。传统系统也不应该试图用固定规则完全覆盖用户自然语言中的复杂语义。

### 3.2 模块责任矩阵

| 流程阶段 | AI Agent 负责 | 传统系统负责 |
|---|---|---|
| 用户输入理解 | 任务识别、意图抽取、反馈归因 | 会话保存、schema 校验、异常输入处理 |
| 澄清决策 | 判断是否追问、生成澄清问题 | 最大澄清轮数、对话保护上限、状态记录 |
| 商品召回 | 生成检索意图、查询改写 | 向量索引、商品库检索、候选去重 |
| 约束理解 | 理解自然语言约束 | 价格/品牌/属性/硬约束校验 |
| 推荐排序 | LLM rerank、语义比较 | 规则排序、分数计算、约束保护 |
| 推荐解释 | 自然语言生成、理由组织 | 提供商品字段、评论证据、图片、价格 |
| 多轮反馈 | 识别反馈类型、更新意图方向 | 存储状态、重新触发 pipeline、记录 trace |
| 评估监控 | 可辅助失败解释 | 指标计算、回归测试、失败重放 |

### 3.3 必须由传统系统兜底的内容

- 商品是否存在。
- 商品价格是多少。
- 商品品牌是什么。
- 商品是否违反预算。
- 商品是否违反用户明确排除的品牌或属性。
- 推荐理由是否有 metadata 或 review 证据。
- Agent 是否超过澄清上限。
- 每次推荐是否被完整记录。
- 评估指标是否可复现。

### 3.4 可以由 AI Agent 处理的内容

- 自然语言需求理解。
- 任务分类。
- 模糊偏好归纳。
- 澄清问题生成。
- 评论摘要和证据组织。
- LLM rerank。
- 推荐解释生成。
- 用户反馈归因。

---

## 4. 整体系统架构

### 4.1 分层架构

```text
React Frontend
  - Chat Assistant
  - Product Cards
  - Match Tags / Evidence
  - Agent Workflow Panel
  - Debug / Evaluation View

FastAPI Backend
  - Chat API
  - Product API
  - Session API
  - Trace API
  - Evaluation API

Agent Orchestration Layer
  - Task Router
  - Intent Parser
  - Clarification Policy
  - Feedback Updater
  - LLM Reranker
  - Response Generator

Traditional Recommendation Layer
  - Product Catalog
  - User Profile Builder
  - Vector Retriever
  - Constraint Verifier
  - Rule Ranker
  - Evidence Retriever

Data and Index Layer
  - Amazon Reviews 2018 5-core
  - Amazon Metadata
  - Review Evidence
  - User Behavior Profiles
  - Vector Index
  - Product Store

Harness Engineering Layer
  - Trace Logger
  - Golden Test Set
  - Evaluation Runner
  - Replay Tool
  - Config Manager
  - Prompt / Model Versioning
```

### 4.2 核心请求链路

```text
User Message
  -> Task Router
  -> Intent Parser
  -> Session State Manager
  -> User Profile Service
  -> Clarification Policy
  -> Product Retriever
  -> Constraint Verifier
  -> Rule Ranker
  -> LLM Reranker
  -> Response Generator
  -> Feedback Updater
  -> Trace Logger
```

### 4.3 推荐输出结构

推荐响应不应该只是自然语言文本，而应该包含结构化结果：

```json
{
  "message": "推荐说明文本",
  "intent_state": {},
  "products": [
    {
      "product_id": "",
      "title": "",
      "price": null,
      "image_url": "",
      "matched_tags": [],
      "evidence": [],
      "uncertainties": [],
      "score_breakdown": {}
    }
  ],
  "workflow_trace": {}
}
```

---

## 5. Harness Engineering 边界

Harness Engineering 不是推荐算法本身，也不是 Agent 智能本身，而是支撑系统可运行、可复现、可评估、可调试的一整套工程支架。

### 5.1 属于 Harness 的部分

| 组件 | 作用 |
---|---|
| Dataset Builder | 稳定构建商品库、评论证据和用户画像 |
| Catalog Sampler | 从大商品库中抽取可演示精修商品池 |
| Index Builder | 可复现地构建向量索引 |
| Golden Test Set | 固定关键回归案例 |
| Evaluation Runner | 自动计算评估指标 |
| Trace Logger | 记录每一步 Agent 决策 |
| Replay Tool | 重放失败案例 |
| Config Manager | 管理模块开关、top_k、澄清上限等参数 |
| Prompt / Model Versioning | 记录 prompt 和模型版本变化 |
| Mock / Cached LLM | 降低测试成本，提高 demo 稳定性 |

### 5.2 推荐 Trace Schema

```json
{
  "turn_id": "",
  "session_id": "",
  "input": "",
  "task_type": "",
  "intent_state": {},
  "clarification": {
    "should_clarify": false,
    "question": "",
    "reason": ""
  },
  "retrieved_items": [],
  "filtered_items": [],
  "ranked_items": [],
  "reranked_items": [],
  "final_response": "",
  "feedback_update": {},
  "metrics": {}
}
```

### 5.3 Harness 的工程价值

没有 Harness，系统只能“看起来能跑”。有 Harness，系统才能做到：

- 失败可定位。
- 结果可复现。
- prompt 变化可比较。
- rerank 效果可回归。
- 用户反馈处理可测试。
- Demo 前可以跑 golden cases。

---

## 6. 核心技术难点

### 6.1 Amazon 5-core 不是产品级商品库

Amazon Reviews 2018 5-core 的优势是行为数据密集，适合构造用户画像。但它不是为产品导购设计的数据源，可能存在：

- metadata 缺失。
- price 字段不完整。
- image 字段不稳定。
- 属性结构不统一。
- 评论噪声大。
- 类目粒度不一致。

应对策略：

- 建立数据清洗 pipeline。
- 保留 `unknown` 状态。
- 维护一个 curated demo pool。
- 不让 LLM 补造缺失事实。

### 6.2 用户自由输入导致任务边界复杂

用户可能提出：

- 单品推荐。
- 平替推荐。
- 负反馈。
- 商品对比。
- 礼物推荐。
- 组合推荐。
- 实时库存。
- 真实下单。

应对策略：

- 使用 Task Router。
- 对任务做分层支持。
- MVP 满血支持：单品推荐、负反馈重推荐、平替推荐。
- 对复杂任务优雅降级。

### 6.3 IntentState 设计决定系统上限

意图状态太粗，会导致反馈更新和澄清质量差；意图状态太细，会导致抽取不稳定。

当前 MVP 字段：

```json
{
  "task_type": "",
  "category": "",
  "goal": "",
  "scenario": "",
  "budget": null,
  "brand_preference": [],
  "price_sensitivity": "",
  "priority_order": [],
  "hard_constraints": [],
  "soft_preferences": [],
  "negative_preferences": [],
  "target_user": "",
  "uncertainty_fields": [],
  "feedback_history": [],
  "long_term_profile": {}
}
```

### 6.4 澄清策略容易失控

动态澄清是 Agent 感的来源，但如果没有保护，系统可能一直追问。

建议保护：

```text
max_consecutive_clarifications = 3
max_total_dialog_turns_before_recommend = 5
```

超过上限后，系统必须推荐，并标注不确定点。

### 6.5 LLM rerank 可能破坏硬约束

LLM 很容易因为“语义上看起来合适”而把违规商品排到前面。

应对策略：

- 先做硬约束过滤。
- LLM rerank 只处理安全候选集。
- rerank 后再做 final validation。
- Trace 中记录 rerank 前后变化。

### 6.6 证据化解释难

推荐理由必须绑定：

- 商品 metadata。
- features。
- review snippets。
- rating statistics。

如果证据缺失，应该说“不确定”，不能让 LLM 自行补事实。

### 6.7 用户画像可能污染当前意图

Amazon 行为数据构造的长期画像只能作为弱信号。当前用户本轮表达的意图应优先。

原则：

```text
session_intent > explicit_feedback > long_term_profile
```

### 6.8 可观测性必须前置

Agent 系统错误通常不是单点错误，而是链路错误。没有 trace 时，很难判断失败来自：

- task routing。
- intent parsing。
- retrieval。
- constraint verification。
- ranking。
- LLM rerank。
- response generation。
- feedback update。

因此 Trace Logger 和 Replay Tool 应尽早实现。

---

## 7. 技术选型与依据

### 7.1 FastAPI

选择依据：

- Python 生态适合推荐、数据处理、LLM 和向量检索。
- FastAPI 与 Pydantic 结合紧密，适合结构化 schema。
- 自动生成 API 文档，方便 React 前端联调。
- 支持异步接口，适合 LLM 调用和检索调用。

主要用途：

- Chat API。
- Session API。
- Product API。
- Trace API。
- Evaluation API。

替换时机：

- 如果后续需要高并发线上系统，可将高 QPS 检索服务拆到 Go/Java，但 MVP 阶段不需要。

### 7.2 Pydantic v2

选择依据：

- FastAPI 原生适配。
- 适合定义 `IntentState`、`Product`、`RecommendationResult`、`Trace`、`EvaluationCase`。
- 可校验 LLM 输出，防止脏 JSON 进入 pipeline。

关键价值：

> Pydantic 是 LLM 与传统系统之间的结构化护栏。

### 7.3 Polars / Pandas + PyArrow / Parquet

选择依据：

- Amazon review 和 metadata 数据量较大。
- Polars 更适合中等规模本地批处理。
- Pandas 生态成熟，适合探索和小规模清洗。
- Parquet 读取快、压缩好、schema 稳定。

主要用途：

- 原始数据清洗。
- 商品 metadata 标准化。
- review evidence 构造。
- 用户画像构造。

### 7.4 DuckDB

选择依据：

- 适合本地查询 Parquet。
- 不需要部署数据库服务。
- 对抽样、统计、构建 demo pool 很方便。

主要用途：

- 类目统计。
- 商品池抽样。
- 数据质量分析。
- 离线评估分析。

### 7.5 SQLite / PostgreSQL

MVP 建议：

```text
SQLite + Parquet + FAISS
```

后续升级：

```text
PostgreSQL + Qdrant 或 pgvector
```

SQLite 选择依据：

- 零配置。
- 适合本地 demo。
- 对 20k-50k 商品规模足够。

PostgreSQL 选择依据：

- 更适合多用户并发。
- 支持复杂查询。
- 可以接 pgvector。

### 7.6 FAISS

选择依据：

- 本地向量检索快。
- 适合 MVP 和离线 demo。
- 不依赖外部服务。
- 20k-50k 商品规模非常轻松。

主要用途：

- 用户自然语言需求到商品候选召回。
- 平替推荐。
- 相似商品检索。

替换时机：

- 如果需要服务化、在线增删、metadata filtering，可升级为 Qdrant。

### 7.7 Qdrant

定位：

- 后续产品化升级选项。

选择依据：

- 服务化向量数据库。
- 支持 metadata filter。
- API 清晰。
- 更适合多用户和长期运行服务。

### 7.8 Embedding 模型

推荐选择：

```text
英文商品库优先：bge-base-en-v1.5 / all-MiniLM-L6-v2
中英混合输入：bge-m3 / multilingual-e5
```

依据：

- Amazon 商品数据以英文为主。
- 用户可能输入中文。
- 如果前端允许中文输入，推荐使用 `bge-m3` 或 `multilingual-e5`。
- 如果只做英文 demo，`all-MiniLM-L6-v2` 速度快、成本低。

### 7.9 OpenAI-compatible LLM Adapter

选择依据：

- 不绑定单一模型供应商。
- 可以切换 OpenAI、DeepSeek、Qwen、Claude-compatible gateway 或本地 vLLM。
- Agent 中多个节点都需要 LLM：
  - intent parsing
  - clarification generation
  - LLM rerank
  - response generation

工程要求：

- 所有 LLM 输出必须 schema 校验。
- LLM 不直接决定商品事实。
- LLM rerank 只能处理已过滤候选。
- 支持 mock/cached LLM output。

### 7.10 React + Vite + TypeScript

选择依据：

- 比 Streamlit 更有产品成熟度。
- 组件化适合聊天窗口、商品卡片、工作流面板、意图状态视图。
- Vite 启动快，工程轻。
- TypeScript 让前后端数据结构更稳定。

主要组件：

- `ChatWindow`
- `ProductCardList`
- `AgentWorkflowPanel`
- `IntentStateView`
- `TraceViewer`

### 7.11 TanStack Query + Zustand

TanStack Query 依据：

- 适合管理 API 请求、缓存、loading、error 状态。
- 可管理 chat、trace、product results 等异步数据。

Zustand 依据：

- 轻量。
- 适合管理 session、UI panel 状态、选中商品等前端状态。

### 7.12 Tailwind CSS

选择依据：

- 快速构建现代 UI。
- 适合商品卡片、标签、布局、状态面板。
- 不需要大量手写 CSS。

UI 风格原则：

- 工具型、产品型、信息密度高。
- 不做营销页。
- 不使用过重装饰。

### 7.13 pytest + JSONL + YAML

pytest 依据：

- Python 标准测试生态。
- 适合模块测试、pipeline 测试、端到端测试。

JSONL 依据：

- 适合 golden cases。
- 每行一个样例，方便追加和流式读取。

YAML 依据：

- 适合管理实验配置：

```yaml
use_llm_rerank: true
use_user_profile: true
retriever_top_k: 100
reranker_top_k: 10
max_consecutive_clarifications: 3
embedding_model: bge-m3
```

---

## 8. 推荐工程目录结构

```text
backend/
  app/
    api/
      chat.py
      products.py
      sessions.py
      traces.py
      evaluation.py
    schemas/
      intent.py
      product.py
      recommendation.py
      trace.py
      evaluation.py
    services/
      task_router.py
      intent_parser.py
      clarification_policy.py
      profile_service.py
      retriever.py
      constraint_verifier.py
      ranker.py
      llm_reranker.py
      response_generator.py
      feedback_updater.py
    data_pipeline/
      load_amazon.py
      normalize_products.py
      build_profiles.py
      build_evidence.py
      build_index.py
    harness/
      trace_logger.py
      replay.py
      config.py
      prompt_registry.py
    evaluation/
      eval_task_type.py
      eval_intent_slots.py
      eval_constraints.py
      eval_evidence.py
      eval_feedback.py
    storage/
      product_store.py
      profile_store.py
      vector_store.py

frontend/
  src/
    components/
      ChatWindow/
      ProductCard/
      AgentWorkflowPanel/
      IntentStateView/
      TraceViewer/
    api/
    state/
    types/

data/
  raw/
  processed/
  indexes/
  eval/

docs/
tests/
configs/
```

---

## 9. 推荐开发顺序

### Phase 1: 数据管道

- 加载 Amazon 5-core 和 metadata。
- 标准化商品 schema。
- 构建 review evidence。
- 构建用户画像。
- 生成 20k-50k 商品库。
- 抽取 curated demo pool。

### Phase 2: 推荐核心

- 构建 embedding。
- 建立 FAISS index。
- 实现 Retriever。
- 实现 Constraint Verifier。
- 实现 Rule Ranker。

### Phase 3: Agent Orchestration

- 实现 Task Router。
- 实现 Intent Parser。
- 实现 Session State。
- 实现 Clarification Policy。
- 实现 Feedback Updater。

### Phase 4: LLM 能力

- 接入 LLM adapter。
- 实现 schema-based intent parsing。
- 实现 LLM rerank。
- 实现 evidence-grounded response generation。

### Phase 5: React 前端

- 聊天界面。
- 商品卡片。
- Agent 工作流面板。
- IntentState 展示。
- Trace 展示。

### Phase 6: Harness 与评估

- Golden test set。
- Evaluation runner。
- Replay tool。
- Prompt/model version tracking。
- Demo regression cases。

---

## 10. 架构原则总结

1. **Workflow 托底，Agent 增强。**  
   主流程固定，AI 负责局部语义判断。

2. **商品事实不交给 LLM。**  
   价格、品牌、图片、评论、属性都必须来自商品库。

3. **硬约束不能被 rerank 覆盖。**  
   LLM rerank 只在安全候选集中工作。

4. **当前意图优先于长期画像。**  
   用户本轮明确表达的需求优先级最高。

5. **不确定就显式标注。**  
   缺失字段不能由 LLM 补造。

6. **Trace 必须前置。**  
   没有 trace 的 Agent 系统不可调试。

7. **Harness 是产品成熟度的一部分。**  
   可复现、可评估、可重放，比一次顺利 demo 更重要。

一句话总结：

> InteRecAgent 的合理架构不是让 AI 接管推荐系统，而是让 AI 成为推荐系统中的语义决策层；传统系统负责事实、约束、排序和评估，Harness 负责让整个 Agent 产品可控、可复现、可迭代。
