# InteRecAgent 项目目录设计与成熟 Agent 项目参考

**版本**：1.1
**日期**：2026-08-16
**项目**：InteRecAgent
**文档类型**：技术架构——前后端服务目录设计与选型参考

**关联**：[cross-border-shopping-agent-prd.md](./cross-border-shopping-agent-prd.md)、[technical-architecture-and-selection.md](./technical-architecture-and-selection.md)、[buywhere-adapter-verification.md](./buywhere-adapter-verification.md)

## 1. 目的与边界

本文固化 InteRecAgent 前后端服务的工作目录设计，并记录支撑该设计的成熟开源 Agent 项目调研，目的是：

- 明确「代码放哪里、依赖向哪里、接缝在哪」，供后续实现、评审与新成员参考，避免反复讨论。
- 把技术选型文档（FastAPI BFF + LangGraph Orchestrator + React 任务工作区）落成可执行的目录形态。
- 记录调研结论，标明哪些决策经过成熟项目验证、哪些缺口由调研暴露并补齐。
- 贯彻软件工程开闭原则（OCP）：后端对变化点建模为端口 + 注册表，由组合根装配；稳定面封闭（见 §3.5）。

与产品范围一致：本文只定义目录与归属，不涉及运费/税费/到手价计算、支付、下单或物流。`adapter` 与 LLM 边界只负责「取数和安全注入」，不承担业务事实。

## 2. 总体原则（成熟项目一致性规律）

调研 7 个成熟项目（详见 §5）后归纳的一致性规律，作为目录设计的评判标准：

1. **编排层独立成包** —— agent 运行时（smolagents `agents.py`、MetaGPT `roles/ teams/`、LangGraph 应用模板 `agent/`、nanobot `agent/`）不与 HTTP 边界或领域逻辑混放。
2. **数据接入按「数据源」拆分、单独立层** —— 同一领域数据按源拆文件（购物 agent `scrapers/{jd,taobao,zhihu}.py`、nanobot `channels/ providers/`、MetaGPT `tools/`），新增源就是新增文件/子包。
3. **LLM 接入单独隔离** —— smolagents `models.py`、MetaGPT `providers/`、nanobot `providers/`（含 `factory.py/registry.py/fallback/unconfigured`）。换模型不改业务代码。
4. **领域模型从编排中剥离** —— 购物 agent `models/product.py`、smolagents `agent_types.py`、本项目 `domain/models.py`，与 agent 逻辑分离。
5. **状态/会话与编排分离** —— 购物 agent `context/`、nanobot `session/`；业务事实不放进图/框架的 checkpoint。
6. **可观测性是一等公民** —— smolagents `monitoring.py` 等有专门归属；MVP 阶段资产不重，可先挂服务层（见 §6）。
7. **依赖方向单向** —— MetaGPT `roles/ actions/ → tools/ providers/`；购物 agent `agent.py → scrapers + analysis + models + context`。编排可以依赖数据/决策层，反向禁止。
8. **对扩展开放、对修改关闭（OCP）** —— 变化点（数据源、LLM 提供商、排序策略、Agent 节点）建模为「端口 + 注册表」，由组合根按配置装配；稳定面（编排流程、对外契约）不因扩展而修改。nanobot `providers/factory.py + registry.py`、MetaGPT `tools/` 均为该机制，详见 §3.5。

## 3. 定稿目录设计

### 3.1 后端 `backend/`（Python 包，自包含）

```text
backend/
├── api/                        # FastAPI BFF —— HTTP/SSE 边界（新增接缝）
│   ├── app.py                  #   组合根：装配 registry、注入 services
│   ├── routes/                 #   按域拆路由；新路由 = 新文件 + include_router
│   ├── schemas.py              #   对外请求/响应契约（封闭）
│   └── deps.py                 #   DI：按配置从 registry 取实现注入
├── agent/                      # LangGraph Mission Orchestrator（新增接缝）
│   ├── state.py                #   ShoppingMission 状态模型（纯 Pydantic，先立）
│   ├── graph.py                #   状态图构建：由节点注册表装配
│   └── nodes/                  #   ★ 节点即插件：新节点 = 新文件 + 注册，不改 graph.py
│       ├── registry.py         #   节点注册表（name → 可调用）
│       ├── parse_intent.py     #   意图/约束解析
│       ├── ask_clarification.py #  单问题追问
│       └── compose_recommendation.py
├── services/                   # 用例编排（封闭）—— 只依赖端口与策略接口
│   └── search_service.py
├── domain/                     # 决策层（现有）—— 事实/决策/语言分离
│   ├── models.py
│   ├── normalize.py
│   └── strategies/             # ★ 决策策略（开放）：新策略 = 新文件 + 注册
│       ├── base.py             #   端口：Ranking / Filter / Dedupe 策略接口 + 注册表
│       ├── ranking_price.py    #   人民币价升序（现状迁移）
│       ├── ranking_score.py    #   综合评分（P1 评分体系接缝）
│       ├── filter_budget.py    #   预算硬过滤（现状迁移）
│       └── dedupe_title.py     #   同款去重（现状迁移）
├── adapters/                   # 数据接入层 —— 实现端口契约，服务端持有 Key
│   ├── ports.py                #   ★ 端口契约（封闭）：ProductSource / FxSource / ModelBackend
│   ├── registry.py             #   ★ 注册表：name → 实现（扩展点）
│   ├── buywhere.py             #   BuyWhere 数据源（实现 ProductSource + @register）
│   ├── fx.py                   #   Frankfurter 汇率源（实现 FxSource + @register）
│   └── llm/                    #   LLM 提供商（实现 ModelBackend）
│       ├── base.py             #   接口（结构化输出 + 工具调用）
│       ├── openai_responses.py #   OpenAI Responses API（架构首选）
│       ├── openai_compat.py    #   OpenAI 兼容协议 → DeepSeek（.env 现状）
│       ├── unconfigured.py     #   未配置 Key → 安全降级（部分成功原则）
│       └── factory.py          #   按配置路由到注册的实现
├── tests/                      # 由根 tests/ 迁入（fixture 随迁）
├── main.py                     # uvicorn 入口
└── cli.py                      # 真实链路验证 CLI（现有）
```

### 3.2 前端 `frontend/`（React 任务工作区）

```text
frontend/
└── src/
    ├── api/                    # 通信边界（关键接缝）—— 现在放 mock，将来换 client
    │   └── mock.ts             #   对外暴露与未来 client 相同的函数签名
    ├── components/             # 跨视图共享：Conversation / PriceEvidence / EvidenceStrip / FxStrip / ChangeSummary / Drawer
    ├── views/                  # 页面级：Home / Workspace（候选+对话）/ Compare / TaskList
    ├── lib/                    # 纯函数：预算/意图解析、格式化
    ├── types.ts                # 领域类型：Mission / Product / Message
    ├── platform-logos/
    ├── App.tsx
    └── styles.css
```

### 3.3 依赖方向

```text
api → services → agent → domain + adapters
```

- 前端只能经过 `backend/api`，不碰 adapter 或原始 BuyWhere 字段。
- `agent/`（编排）不得绕过 `domain/` 决策层。
- `domain/`、`adapters/` 禁止 import `agent/` 或 `api/`。
- 决策层执行确定性硬过滤/排序；LLM 只提查询计划、约束变更与解释草案，真实商品事实来自 `adapters/`。
- 依赖倒置（OCP 的实现机制）：`services/`、`agent/` 只依赖 `adapters/ports.py` 与 `domain/strategies/base.py` 的接口，不依赖具体实现；具体实现由组合根（`api/deps.py`、`cli.py`）按配置注入。

### 3.4 现状对照

| 路径 | 状态 |
|---|---|
| `backend/domain/`、`backend/adapters/buywhere.py + fx.py`、`backend/service.py`、`backend/cli.py` | 已有（真实链路验证通过） |
| `backend/api/`、`backend/services/search_service.py`、`backend/agent/{state.py, nodes/}`、`backend/adapters/{ports.py, registry.py, llm/}`、`backend/domain/strategies/` | 目标接缝，择机创建 |
| `backend/tests/` | 迁移目标；当前 `tests/` 在根目录 |
| `frontend/src/{api, components, views, lib, types.ts}` | 目标；当前全部逻辑在 `App.tsx` 单文件 + 全局 mock 数据 |

### 3.5 后端开闭原则（OCP）落地

目录按「对扩展开放、对修改关闭」组织：把**预期会变化**的地方建模为端口与注册表，稳定面保持封闭。核心机制是**依赖倒置**——业务代码只依赖接口，具体实现由组合根装配，扩展时零修改现有业务代码。

| 扩展点（开放） | 端口契约 | 扩展方式（新增文件 + 注册） | 封闭面 |
|---|---|---|---|
| 新数据源 / 新平台 | `adapters/ports.py::ProductSource` | 新增 `adapters/<source>.py` 实现端口并 `@registry.register` | `services/`、`domain/` 只依赖端口 |
| 新汇率源 | `adapters/ports.py::FxSource` | 同上 | 同上 |
| 新 LLM 提供商 | `adapters/ports.py::ModelBackend` | `adapters/llm/<provider>.py` 实现并在 factory 注册 | `agent/` 不感知具体模型 |
| 新排序 / 过滤 / 去重策略 | `domain/strategies/base.py` 策略端口 | `domain/strategies/<name>.py` 注册 | `services/` 按配置选策略 |
| 新 Agent 节点 | `agent/nodes/registry.py` | `agent/nodes/<name>.py` 注册 | `graph.py` 装配方式不变 |
| 新 API 路由 | FastAPI Router | 新增 `api/routes/<name>.py` + include_router | `schemas.py` 对外契约稳定 |

组合根是唯一的改动集中点：`api/deps.py`、`cli.py` 读取配置，从 registry 选取实现并注入服务。业务代码中不出现 `if 平台 == ...`、`if 模型 == ...` 这类分支；未配置的能力由默认实现兜底（如 `adapters/llm/unconfigured.py`），对应「部分成功是正常结果」。

对不变化的点不做抽象：`domain/models.py`、`normalize.py` 是稳定数据与映射，保持平铺即可。OCP 只对真实变化点建模，避免为了原则而抽象。

## 4. 设计决策与调研验证对照

| 定稿决策 | 验证项目 | 结论 |
|---|---|---|
| 编排层独立成包 `agent/` | nanobot / MetaGPT / LangGraph / smolagents | ✅ 铁律 |
| 数据接入按源拆分 `adapters/` | 购物 agent / nanobot `channels/` / MetaGPT `tools/` | ✅ |
| 领域模型剥离 `domain/models.py` | 购物 agent `models/` / smolagents `agent_types.py` | ✅ |
| 会话状态独立于编排 | nanobot `session/` / 购物 agent `context/` | ✅ |
| 前端 `components/ + views/ + lib/ + types/` | nanobot webui / OpenHands src | ✅ |
| monorepo 平级 `frontend/ + backend/` | nanobot `webui/` 顶层平级 | ✅ |
| mock 收敛到 `api/` 服务边界 | OpenHands `services/ api/` | ✅ 命名有先例 |
| 依赖单向 `api→services→agent→domain+adapters` | MetaGPT / 购物 agent | ✅ |
| LLM 边界独立 | nanobot `providers/`（最强范本） | ⬜→✅ 升级为 `adapters/llm/` 小包 |
| 可观测/证据层 | smolagents `monitoring.py` | ⬜ MVP 先挂 `services/`，见 §6；落库后归 PostgreSQL/观测体系 |
| OCP 端口 + 注册表 + 组合根装配 | nanobot `providers/factory.py + registry.py`、MetaGPT `tools/` | ✅ 机制成熟，落地见 §3.5 |

## 5. 成熟项目参考调研明细

调研方法：`gh api` 拉取各仓库真实目录树（2026-08-16），非文档推测。LangGraph 应用模板的结构取自框架文档规范（仓库模板未能直接拉取，标注为规范而非实测）。

| 项目 | 形态 | 结构要点 | 本项目参考 |
|---|---|---|---|
| [HKUDS/nanobot](https://github.com/HKUDS/nanobot)（47k★） | 超轻量自托管 AI Agent：后端 + webui + 多渠道 | `nanobot/{agent, api, channels, providers, session, config, security, skills, templates, triggers, bus, utils}`；顶层 `webui/src/{components, hooks, lib, types, providers}`；`providers/` 含 `base / factory / registry / openai_responses / openai_compat / anthropic / azure / bedrock / xai / fallback / unconfigured` | LLM 边界小包形态、会话独立、webui 与后端平级 |
| [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 多角色 Agent 平台 | `metagpt/{roles, actions, teams, memory, strategies, providers, tools, rag, documents, utils}` | 角色/子系统组织；`providers/` 隔离 LLM |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)（选型编排） | Agent 编排框架 | 仓库为多包 `libs/`；**应用模板规范**：`state.py / nodes.py / graph(agent).py / tools.py / configuration.py` | `agent/state.py` + `nodes/` 起始形态 |
| [huggingface/smolagents](https://github.com/huggingface/smolagents) | 轻量 Agent 框架 | `src/smolagents/{agents, models, tools, default_tools, memory, monitoring, mcp_client, serialization, utils, cli}.py` | 单包最小分层范式 |
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | 生产级 Agent 产品 | 前端 `src/{components, hooks, services, api, stores, types, ui, utils, routes}` + `electron/ docker/ helm/ config/ tools/` | 前端服务边界层；大工程组织 |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 多 Agent 框架 | 多语言分包 `python/ dotnet/` | 语言/服务边界清晰 |
| [frieren-123/shopping-agent-ai](https://github.com/frieren-123/shopping-agent-ai) | **同领域**跨平台比价购物 Agent | `src/agent.py` + `src/scrapers/{jd, taobao, vip, xhs, zhihu}.py` + `src/analysis/{scorer, feedback_loop}.py` + `src/models/product.py` + `src/context/context_manager.py` | 与 InteRecAgent 形态最接近：平台接入按源拆文件、领域模型/会话独立 |

## 6. 调研暴露的缺口与修订

1. **LLM 接入边界（新增）**——初期只计划 `adapters/llm.py` 单文件；nanobot `providers/` 证明接口/实现/降级/工厂四件事需要小包形态。落为 `adapters/llm/`（§3.1）。这同时把架构文档「OpenAI Responses vs DeepSeek」未决项变成一个接口两套实现（`openai_responses.py` / `openai_compat.py`）的接缝，`unconfigured.py` 支撑「部分成功是正常结果」。
2. **观测/证据层归属（明确）**——MVP 阶段证据快照尚未落库，不建独立包。trace 关联（`mission_id` / `run_id`）先挂 `services/` 层，随 PostgreSQL/Celery 落地自然归位。
3. **测试归属（迁入）**——`tests/` 迁至 `backend/tests/`，`pyproject.toml` `testpaths` 同步修改，fixture 随迁；前端 Playwright e2e 后续放 `frontend/tests/e2e/`。
4. **mock 边界（收敛）**——前端全部 mock 数据从 `App.tsx` 迁入 `src/api/mock.ts`，组件只依赖 `types.ts` 与 client 接口，`VITE_USE_MOCKS` 开关切换。这是前后端打通的前置条件。
5. **决策策略化（OCP 落地）**——现有 `domain/filter_rank.py` 的过滤/去重/排序拆入 `domain/strategies/`（`filter_budget.py` / `dedupe_title.py` / `ranking_price.py`），`service.py` 改为按配置选取策略；为 PRD §7.3 的 8 维综合评分留扩展接缝，不修改既有逻辑。

## 7. 演化方向

- `session/`：当 ShoppingMission 状态开始承担持久化与恢复时，从 `agent/state.py` 演化出 `backend/session/`（nanobot 先例）。
- 证据与观测：PostgreSQL 落地后，`product_snapshots / fx_snapshots / recommendation_runs` 归数据层，观测随 OpenTelemetry/Sentry 形成 `backend/observability/` 或并入基础设施。
- 价格历史与提醒：P1 的愿望清单/目标价/提醒归 Celery 异步任务，目录随任务域再定，不预先占位。
- 前端打通：`api/mock.ts` → `api/client.ts` 时，Contract（类型 + schema）与后端 `api/schemas.py` 对齐。
- 评分体系：PRD §7.3 的 8 维评分落地到 `domain/strategies/`（`ranking_score.py` 及组合策略），按配置/偏好选取，不修改既有策略（OCP）。

## 8. 结论

目录设计的每一个核心决策（编排独立成包、数据按源拆层、LLM 隔离、领域模型剥离、会话独立、前端服务边界、依赖单向、OCP 端口 + 注册表 + 组合根装配）均由 7 个成熟项目交叉验证。调研未推翻结构，而是补齐了三处缺口：LLM 边界升级为 `adapters/llm/` 小包、明确观测层 MVP 归属、决策层策略化以承载开闭原则。本文作为目录契约留档，后续实现与评审以此为准。