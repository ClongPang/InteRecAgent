---
title: InteRecAgent 项目骨架开发、测试与验收规格
version: 1.0-executable
date_created: 2026-08-16
last_updated: 2026-08-16
owner: InteRecAgent 产品与工程团队
tags: [architecture, process, agent, ecommerce, backend, frontend, testing]
---

# Introduction

本文定义 InteRecAgent 从“前端交互原型 + 后端真实数据纵向切片”演进为“可持续开发的项目骨架”的完整方案。本轮由同一 AI 分别站在电商推荐产品经理、Agent/后端架构开发师、前端架构开发师三个角色立场进行交叉审评，不冒充真实人员签字。用户未对评审稿中的两个可逆默认项提出异议，因此 1.0 执行版采用“匿名任务并隔离模拟登录”“确定性 Agent 先行、真实 LLM 后接”；用户可在对应工作包开始前覆盖这两个默认项。目标是让开发者或编码 Agent 按阶段机械执行后，得到一个结构清晰、契约稳定、可本地运行、可自动测试、可接真实 BuyWhere 数据、可继续扩展 Agent 能力的基础实现。

本文是项目骨架阶段的执行规格。若本文与现有目录设计文档在端口归属、依赖方向或骨架范围上冲突，以本文为准；执行后应同步修订旧文档，消除双重事实源。

## 1. Purpose & Scope

### 1.1 目标

骨架完成后必须具备以下可证明能力：

1. 无第三方 API Key 时，可使用脱敏 fixture 启动完整系统并跑通端到端购物任务。
2. 配置真实 BuyWhere Key 时，可切换到真实商品搜索，并保留原币价格、人民币估算、汇率来源、汇率日期、商品来源和商户链接。
3. 用户可创建 `ShoppingMission`、追加消息、修改预算或偏好、查看候选、选择 2–4 件商品比较，并获得证据约束的首选与备选。
4. Agent 以显式状态图编排任务；事实读取、过滤、换算、排序和证据校验由确定性代码执行。
5. 前后端通过版本化 HTTP/SSE 契约连接；前端不读取 BuyWhere 原始响应，后端领域层不依赖 FastAPI、数据库 ORM 或具体供应商。
6. 每个阶段都有自动化测试、验收证据和停止条件，失败时不得继续堆叠后续实现。

### 1.2 本阶段包含

- Monorepo 工程命令、环境配置、质量门禁和 CI 基线。
- FastAPI API、应用用例层、Agent 编排层、领域层、基础设施层和组合根。
- PostgreSQL 中的任务、事件、商品快照、汇率快照、候选集和推荐运行记录。
- BuyWhere 与 Frankfurter 的异步 Adapter，以及 fixture/fixed 测试实现。
- 一个可运行的 LangGraph 单领域 Agent；没有 LLM Key 时使用确定性解析和模板解释。
- React 工作区的模块化拆分、TanStack Query 服务端状态、API/mock 双实现和核心 E2E。
- 事实缺失、汇率失败、部分市场失败、无结果、401、429 和 5xx 的降级路径。

### 1.3 本阶段不包含

- 支付、下单、代购、物流、关税、最终到手价或配送承诺。
- 生产级用户认证、短信服务、账号找回和多租户授权。
- 价格提醒、Celery、Redis 分布式锁、长期价格监控和通知投递。
- 多 Agent 自由协作、长期用户画像、向量数据库和个性化学习排序。
- 对 BuyWhere 未提供的评分、评价数、品牌、库存、规格或折扣进行猜测或补写。

### 1.4 目标读者

- 产品经理：确认业务闭环、事实边界和验收场景。
- 后端/Agent 开发者：按端口、用例、状态图和基础设施分层实现。
- 前端开发者：按 API 契约、视图状态和缺失事实规则实现。
- 测试人员或编码 Agent：按工作包和验收矩阵逐项执行并保存证据。

### 1.5 执行假设与变更窗口

- **ASM-001**：骨架默认允许匿名任务，现有浏览器模拟登录隔离为 demo feature。若用户要求真实认证，必须在 P5-W02 开始前另立认证规格，不得把本地密码哈希直接迁入后端。
- **ASM-002**：骨架默认使用确定性解析与模板解释，真实 LLM Provider 延后。用户可在 P3-W03 开始前指定 OpenAI Responses、DeepSeek/OpenAI-compatible 或其他实现，且不得改变 Port、领域或 API 契约。
- **ASM-003**：本地验收默认可使用 Docker Compose 启动 PostgreSQL。若执行环境无 Docker，可提供兼容的外部 PostgreSQL URL，但迁移和事务验收标准不变。
- **ASM-004**：当前未提交工作树属于用户资产。执行者必须增量迁移并保存行为，不能使用 reset、checkout 或批量删除来获得“干净骨架”。

## 2. Definitions

| 术语 | 定义 |
|---|---|
| ShoppingMission | 一次持续演进的购物决策任务，是预算、偏好、消息、候选、比较和推荐的业务聚合根。 |
| IntentPatch | 从用户输入得到的结构化条件增量，不直接覆盖任务状态。 |
| ProductSnapshot | 某一时刻从商品源取得的原始响应和标准化字段快照。 |
| FxSnapshot | 某一时刻某币种兑换人民币的汇率、来源、汇率日期和抓取时间。 |
| CandidateSet | 在指定 `constraints_version` 下经过归一化、过滤、去重和排序后的候选集合。 |
| RecommendationRun | 一次推荐生成及证据校验记录。 |
| Evidence | 支撑价格、商户、链接、更新时间和推荐理由的可追溯事实引用。 |
| BFF | Backend for Frontend；为 React 工作区提供稳定契约的 FastAPI 服务。 |
| SSE | Server-Sent Events；服务端向浏览器单向推送任务阶段事件。 |
| Port | 应用层声明的能力接口，例如商品源、汇率源、模型后端和任务仓储。 |
| MissionRunner | 应用层声明的任务编排 Port；`LangGraphMissionRunner` 是 Agent 层对该 Port 的实现。 |
| RunDispatcher | 应用层声明的运行调度 Port；骨架使用受进程生命周期管理的实现，在请求返回后执行短生命周期 Agent Run。 |
| Adapter | 外层对应用 Port 的具体实现。供应商和数据库实现位于 Infrastructure，LangGraph 编排实现位于 Agent。 |
| Fixture Mode | 使用脱敏固定数据运行的模式，不访问外网，不需要第三方 Key。 |
| Live Mode | 使用真实 BuyWhere/Frankfurter 服务的模式，仅用于受控开发和冒烟测试。 |
| Partial Success | 部分平台或汇率失败时仍返回可验证的可用结果，并明确缺失信息。 |
| OCP | Open/Closed Principle；变化点通过新增实现扩展，稳定用例和领域规则不随供应商变化。 |

## 3. 三方会议审评记录

### 3.1 电商推荐产品经理审评

产品经理的硬性意见如下：

1. 骨架必须验证“描述需求 → 形成任务 → 检索候选 → 人民币比较 → 比较取舍 → 商户跳转”的最小闭环，不能只创建空目录。
2. 真实 BuyWhere 数据缺失 `rating`、`review_count`、`brand`、`availability`、`structured_specs` 等字段时，API 模式下必须隐藏或显示“未提供”，不得沿用前端 mock 值。
3. 人民币只能称为“商品价估算”，必须同时展示原币价格、汇率来源和日期；运费、税费、配送资格必须提示到商户页确认。
4. 骨架只需支持匿名开发任务；当前浏览器内手机号/密码模拟可以保留为隔离的演示功能，但不得被描述为真实认证。
5. 首期比较数量固定为 2–4 件。硬条件不得自动放宽；无结果时必须给用户可执行的修改建议。
6. `keyword` 是精确型号默认模式；`hybrid`/`semantic` 必须标为探索模式，不能与精确结果使用同一质量承诺。

产品结论：同意进入骨架开发，前提是“事实诚实性”与“闭环可运行”作为发布阻断条件。

### 3.2 Agent/后端架构开发师审评

后端架构师的硬性意见如下：

1. 采用状态机驱动的单领域 Agent，不建立多个自由对话 Agent。
2. 端口属于应用层，不属于 Adapter 包；具体供应商实现放入 `infrastructure/`。这修正现有目录设计中 `adapters/ports.py` 导致的依赖语义倒置。
3. API、应用服务、Agent 节点和基础设施全部采用异步接口。多市场搜索并发执行，但必须限制并发、隔离单市场失败并保持确定性排序。
4. PostgreSQL 是业务事实源；LangGraph checkpoint 只记录图执行位置，不代替任务、事件和证据记录。
5. 每个推荐运行必须绑定 `mission_id`、`constraints_version`、`candidate_set_id` 和证据 ID。旧版本运行完成后不得覆盖新版本任务。
6. 供应商响应只能在基础设施层出现；标准化后才能进入应用和领域层。
7. LLM 通过 `ModelBackend` Port 接入。骨架默认允许 `unconfigured`，使用确定性解析和模板解释，确保无模型 Key 时仍可验收。
8. Redis、Celery、价格提醒不属于本骨架，不创建未被使用的空基础设施。
9. HTTP MissionCommandService 只依赖 `RunDispatcher` Port，调度器只依赖 `MissionRunner` Port；Application 不导入 `backend.agent`。LangGraph Agent 实现 MissionRunner，并可调用注入的 Search/Recommendation Service，避免 Application 与 Agent 互相导入。

后端结论：同意进入骨架开发；必须增加架构依赖检查和数据库迁移验证。

### 3.3 前端架构开发师审评

前端架构师的硬性意见如下：

1. 保留现有视觉和任务工作区交互，但将 500 行以上的 `App.tsx` 拆分为应用壳、功能模块、页面、共享组件和纯函数。
2. 服务端状态由 TanStack Query 管理；表单草稿、抽屉开关等瞬时 UI 状态保留在组件内。不得把后端任务事实复制进新的全局 Store。
3. `fixture.ts` 与 `client.ts` 必须实现同一 `MissionApi` 接口。使用 `VITE_DATA_SOURCE=fixture|api` 切换，不允许组件中散布环境分支。
4. 前端类型以提交到仓库的 OpenAPI 生成类型为边界，并在 CI 中检查生成结果是否漂移。
5. 商品卡、详情和比较表必须按可用字段渲染；缺失评分、规格和库存时布局仍成立。
6. 登录演示功能必须位于独立 feature，默认不阻塞匿名骨架闭环。
7. 使用 Vitest、Testing Library、MSW 和 Playwright 分层测试；E2E 只覆盖高价值闭环，不用脆弱的像素级选择器。

前端结论：同意进入骨架开发；先冻结 API ViewModel，再进行组件拆分，避免围绕错误字段模型重构两次。

### 3.4 会议争议与最终决议

| 编号 | 争议 | 最终决议 |
|---|---|---|
| DEC-001 | 先拆目录还是先打通 API | 先冻结契约与测试，再做结构迁移；每个阶段必须保持测试可运行。 |
| DEC-002 | Port 放 `adapters/` 还是应用层 | 放 `backend/application/ports/`；`backend/infrastructure/` 实现 Port。 |
| DEC-003 | 骨架是否立即依赖真实 Key | 默认 Fixture Mode；Live Mode 是附加冒烟门，不作为普通 CI 前提。 |
| DEC-004 | 是否立即加入 LLM | 建立 Port 和确定性 fallback；真实 LLM 提供商是独立工作包，不阻塞骨架。 |
| DEC-005 | 是否立即加入 PostgreSQL | 加入。任务恢复、事件和证据追溯是架构核心，不能长期依赖浏览器 `localStorage`。 |
| DEC-006 | 是否加入 Redis/Celery | 不加入；等缓存、锁或提醒出现真实用例后再引入。 |
| DEC-007 | 当前模拟登录如何处理 | 隔离为 demo feature，默认匿名开发模式；真实认证另立规格。 |
| DEC-008 | 前端如何显示 BuyWhere 缺失字段 | API 返回 `null + unavailable_fields`；前端隐藏指标或显示“未提供”，不得回填 mock。 |
| DEC-009 | Application 与 Agent 谁依赖谁 | Application 声明 `RunDispatcher`/`MissionRunner` Port；HTTP Command Service 依赖前者，Agent 实现后者并依赖 Application DTO/Service；具体实现只在 Bootstrap 装配。 |

## 4. Requirements, Constraints & Guidelines

### 4.1 业务要求

- **BUS-001**：系统必须允许匿名开发用户创建、读取和继续一个 `ShoppingMission`。
- **BUS-002**：系统必须从用户消息中至少识别商品查询、人民币预算、市场、排序偏好和“仅看有货”意图；无法可靠识别商品查询时必须追问一个问题。
- **BUS-003**：系统必须支持 US、SG、VN、TH、MY 中一个或多个市场；`country_code` 只表示商品市场，不表示配送目的地。
- **BUS-004**：每个展示的人民币估算价必须关联原币价格、FX 来源、FX 日期和抓取时间。
- **BUS-005**：系统必须支持选择 2–4 件候选进行结构化比较。
- **BUS-006**：推荐必须包含一个首选、最多两个备选、理由、取舍和证据 ID；没有证据的断言必须删除。
- **BUS-007**：系统不得承诺最终到手价、配送、正品、保修、退货或售后。
- **BUS-008**：硬约束不得自动放宽。软偏好可以调整，但必须记录为事件并允许用户撤销最近一次条件变更。

### 4.2 架构要求

- **ARC-001**：源码依赖必须无环：`api -> application -> domain`；`agent -> application + domain`；`infrastructure -> application + domain`；`bootstrap -> api + agent + infrastructure + application`。Application 只认识自身声明的 Port，不导入 Agent/Infrastructure 具体实现；领域层不得导入 API、Application、ORM、LangGraph 或供应商代码。
- **ARC-002**：Agent 节点不得直接实例化 BuyWhere、Frankfurter、数据库 Session 或模型 SDK，也不得导入 API/Infrastructure；所有能力通过 Application Port/Service 注入。
- **ARC-003**：所有跨层数据必须使用显式 Pydantic DTO/领域模型，禁止传递未经校验的 `dict[str, Any]`。
- **ARC-004**：业务时间必须以 UTC ISO 8601 保存；展示层负责本地化。
- **ARC-005**：所有 ID 使用 UUID；外部商品 ID 作为 `source_product_id` 保存，不作为内部主键。
- **ARC-006**：环境配置由一个 `Settings` 对象加载并在组合根校验；业务模块不得读取 `os.environ`。
- **ARC-007**：Fixture Mode 与 Live Mode 必须通过依赖注入切换，不得在领域或 React 组件中出现供应商模式分支。

### 4.3 Agent 要求

- **AGT-001**：Agent 必须围绕 `MissionGraphState` 运行，并实现显式节点：接收输入、解析 Patch、合并版本、判断追问、规划搜索、获取商品、获取汇率、归一化、过滤、排序、证据校验、生成解释、持久化结果。
- **AGT-002**：每个节点必须声明输入字段、输出字段和可失败类别；节点输出不得隐式修改未声明状态。
- **AGT-003**：LLM 只允许输出 `IntentPatch`、`SearchPlan` 或 `RecommendationDraft`；不得直接输出最终价格、库存或链接。
- **AGT-004**：最终响应必须从已持久化的 Product/Fx Snapshot 重新组装事实字段。
- **AGT-005**：当 `constraints_version` 变化时，旧运行必须标记 `superseded`，不得提交候选或推荐。
- **AGT-006**：没有 LLM 配置时，确定性解析器和模板解释器必须支撑基础验收场景。

### 4.4 后端要求

- **BE-001**：FastAPI 暴露 `/api/v1` 版本化接口和 live/ready 健康检查。
- **BE-002**：MissionRunner、RunDispatcher、商品源、汇率源、模型后端、任务仓储、事件仓储和事务边界必须定义为应用层 Port。
- **BE-003**：BuyWhere 与 Frankfurter 使用共享 `httpx.AsyncClient`、显式超时、连接复用和受控重试。
- **BE-004**：多市场搜索并发数必须可配置，单市场失败不得导致其他市场结果丢失。
- **BE-005**：错误响应必须包含稳定错误码、类别、是否可重试、用户消息和 `trace_id`，不得暴露密钥或堆栈。
- **BE-006**：数据库变更必须由 Alembic 管理；应用启动不得隐式执行 `create_all`。
- **BE-007**：API 响应不得包含 BuyWhere 原始 payload；原始 payload 只存入受控 JSONB 快照。
- **BE-008**：购买链接必须是从快照白名单字段获得的 HTTPS URL；API 不接受模型生成的任意 URL。
- **BE-009**：202 接受的 Agent Run 必须经 `RunDispatcher` 调度并持久化状态；禁止用 FastAPI `BackgroundTasks` 承担该运行。骨架进程关闭时必须有受控 drain/cancel，启动时必须把未完成且无法恢复的 Run 标记为 `interrupted` 并允许重试。
- **BE-010**：带 `Idempotency-Key` 的写请求必须保存 owner、key、请求指纹和最终响应。同一 owner/key/指纹重试返回原响应，不重复产生 Mission/Event/Run；同一 owner/key 使用不同请求指纹返回 409。

### 4.5 前端要求

- **FE-001**：前端必须包含 Home、Mission Workspace、Compare、Mission List 和 Product Detail 五个核心界面。
- **FE-002**：前端只能通过 `MissionApi` 读取和修改业务状态。
- **FE-003**：API 与 fixture 实现必须返回相同 ViewModel；切换数据源不修改组件。
- **FE-004**：商品事实字段为空时，界面不得使用 mock 默认值；布局必须使用“未提供”“待商户页确认”或隐藏该维度。
- **FE-005**：所有异步界面必须有 loading、empty、degraded、error 和 retry 状态。
- **FE-006**：服务端状态不得以 `localStorage` 作为事实源；`localStorage` 仅可保存 UI 偏好、开发匿名标识和未提交草稿。
- **FE-007**：比较集合限制为 2–4 件，并在客户端和服务端同时校验。
- **FE-008**：核心操作必须具备语义化标签，Playwright 测试优先使用 role/name 定位。

### 4.6 数据与证据要求

- **DAT-001**：至少创建 `shopping_missions`、`mission_events`、`product_snapshots`、`fx_snapshots`、`candidate_sets`、`recommendation_runs`、`idempotency_records` 七张表。
- **DAT-002**：`product_snapshots` 必须保存供应商、供应商商品 ID、原始 payload、标准化字段、契约版本和抓取时间。
- **DAT-003**：标准化商品允许品牌、评分、评价数、库存和规格为空，并列出 `unavailable_fields`。
- **DAT-004**：CandidateSet 必须保存每个候选的保留/排除原因、排序位置和确定性评分输入。
- **DAT-005**：数据库事务必须保证 Mission Event 与 `constraints_version` 更新原子提交。
- **DAT-006**：原始 payload 不直接返回前端，不写入普通 INFO 日志。

### 4.7 安全与可观测性要求

- **SEC-001**：第三方 Key 只能来自服务端环境或 Secret 管理；`.env` 必须被 Git 忽略，`.env.example` 不含真实值。
- **SEC-002**：用户输入、商品标题、metadata 和 URL 均视为不可信输入，进入模型前必须隔离并限制长度。
- **SEC-003**：日志必须对手机号、Key、Authorization 和 Cookie 做脱敏。
- **OBS-001**：每个请求生成或透传 `trace_id`，每次任务运行生成 `run_id`。
- **OBS-002**：结构化日志至少包含 `trace_id`、`mission_id`、`run_id`、节点名、耗时、结果状态和错误码。
- **OBS-003**：SSE 事件必须有递增事件序号，客户端可携带最后事件 ID 恢复。

### 4.8 工程质量要求

- **QLT-001**：根目录必须提供机械化命令：安装、启动依赖、迁移、开发、格式化、静态检查、单测、集成测试、E2E、完整验收。
- **QLT-002**：CI 必须在无第三方 Key 环境中完成后端测试、前端测试、构建、架构检查和 fixture E2E。
- **QLT-003**：Live Smoke 必须单独标记、默认跳过、手动或定时触发，并限制请求数量。
- **QLT-004**：领域与应用层语句覆盖率不得低于 85%；后端总体不得低于 75%；前端核心业务模块不得低于 70%。
- **QLT-005**：所有新接口必须先有失败的契约测试或验收测试，再实现代码。
- **QLT-006**：每个工作包完成后必须执行本阶段门禁；门禁失败不得进入下一阶段。

## 5. 目标架构与目录

### 5.1 总体关系

```text
源码依赖（箭头表示 import）

API ───────────────► Application ─────────► Domain
                         ▲                    ▲
                         │                    │
Agent ──────────────────┘────────────────────┤
Infrastructure ─────────┘────────────────────┘

Bootstrap ─► API + Application + Agent + Infrastructure

运行时装配（箭头表示调用）

React ─► API ─► MissionCommandService ─► RunDispatcher Port
                                                ▲ implements
                                      InProcessRunDispatcher
                                                │ calls
                                                ▼
                                         MissionRunner Port
                                                ▲ implements
                                      LangGraphMissionRunner
                                                │ calls
                           SearchService / RecommendationService
                              │ Product/Fx/Repository Ports
                              ▼
                  BuyWhere / Frankfurter / PostgreSQL Adapters
```

依赖规则：Application 和 Domain 都不导入 Agent/Infrastructure；API 不导入 Agent/Infrastructure；Agent 和 Infrastructure 可以依赖 Application Port/DTO 与 Domain；只有 Bootstrap 知道所有具体实现。`MissionCommandService` 调用 `RunDispatcher` Port；Dispatcher 调用 `MissionRunner` Port；`LangGraphMissionRunner` 可以调用 Search/Recommendation Service，但不得回调 MissionCommandService，从而避免运行时递归。

### 5.2 后端目录

```text
backend/
├── api/
│   ├── app.py
│   ├── dependencies.py
│   ├── errors.py
│   ├── middleware.py
│   ├── schemas/
│   └── routes/
│       ├── health.py
│       ├── missions.py
│       └── product_snapshots.py
├── application/
│   ├── dto/
│   ├── ports/
│   │   ├── mission_runner.py
│   │   ├── run_dispatcher.py
│   │   ├── product_source.py
│   │   ├── fx_source.py
│   │   ├── model_backend.py
│   │   ├── repositories.py
│   │   └── unit_of_work.py
│   └── services/
│       ├── mission_service.py
│       ├── search_service.py
│       └── recommendation_service.py
├── agent/
│   ├── state.py
│   ├── graph.py
│   └── nodes/
│       ├── parse_intent.py
│       ├── clarification.py
│       ├── plan_search.py
│       ├── fetch_products.py
│       ├── fetch_fx.py
│       ├── decide.py
│       └── compose.py
├── domain/
│   ├── models.py
│   ├── errors.py
│   └── policies/
│       ├── normalize.py
│       ├── filter.py
│       ├── dedupe.py
│       ├── ranking.py
│       └── evidence.py
├── infrastructure/
│   ├── product_sources/
│   │   ├── buywhere.py
│   │   └── fixture.py
│   ├── fx_sources/
│   │   ├── frankfurter.py
│   │   └── fixed.py
│   ├── llm/
│   │   ├── unconfigured.py
│   │   └── factory.py
│   ├── runtime/
│   │   └── in_process_dispatcher.py
│   └── persistence/
│       ├── database.py
│       ├── orm.py
│       ├── repositories.py
│       └── unit_of_work.py
├── bootstrap/
│   ├── settings.py
│   └── container.py
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── architecture/
│   ├── live/
│   └── fixtures/
├── main.py
└── cli.py
```

### 5.3 前端目录

```text
frontend/src/
├── app/
│   ├── App.tsx
│   ├── providers.tsx
│   └── routes.tsx
├── api/
│   ├── contract.ts
│   ├── client.ts
│   ├── fixture.ts
│   ├── factory.ts
│   └── generated.ts
├── features/
│   ├── missions/
│   ├── candidates/
│   ├── comparison/
│   ├── products/
│   └── demo-auth/
├── components/
│   ├── ui/
│   └── evidence/
├── views/
│   ├── HomeView.tsx
│   ├── MissionView.tsx
│   ├── CompareView.tsx
│   └── MissionListView.tsx
├── lib/
│   ├── format.ts
│   ├── guards.ts
│   └── storage.ts
├── styles/
│   ├── tokens.css
│   └── global.css
├── test/
│   ├── setup.ts
│   └── fixtures.ts
└── main.tsx
```

### 5.4 根目录工程文件

```text
.
├── .env.example
├── .gitignore
├── Makefile
├── compose.yaml
├── alembic.ini
├── migrations/
├── scripts/
│   ├── check_architecture.py
│   ├── export_openapi.py
│   └── acceptance.sh
├── spec/
├── docs/
├── backend/
├── frontend/
└── .github/workflows/ci.yml
```

### 5.5 依赖清单与使用边界

具体兼容版本由 `uv.lock` 和 `package-lock.json` 锁定；依赖清单是执行要求，执行者不得用功能重叠的大型框架替代而不更新本规格。

#### 后端运行依赖

| 能力 | 包 | 使用边界 |
|---|---|---|
| API/Schema | FastAPI、Pydantic v2、pydantic-settings、Uvicorn | 仅 API、DTO、配置和进程入口。 |
| HTTP | httpx | 共享 AsyncClient；供应商访问仅在 Infrastructure。 |
| 重试 | Tenacity | 仅可重试且幂等的上游读取；401 和校验错误不重试。 |
| Agent | LangGraph | 实现 MissionRunner；不保存唯一业务事实。 |
| Persistence | SQLAlchemy 2 async、asyncpg、Alembic | PostgreSQL Repository 和显式迁移。 |
| Logging | structlog | JSON 结构化日志和敏感字段脱敏。 |

#### 后端开发依赖

| 能力 | 包 |
|---|---|
| 测试 | pytest、pytest-asyncio、respx、pytest-cov |
| 静态质量 | Ruff、mypy、import-linter |

#### 前端运行依赖

| 能力 | 包 | 使用边界 |
|---|---|---|
| UI | React、React DOM | 现有 UI 基础。 |
| 路由 | React Router | URL 对应任务与页面，支持刷新恢复。 |
| Server State | TanStack Query | Mission/API 状态、缓存和失效；不保存表单草稿。 |

#### 前端开发依赖

| 能力 | 包 |
|---|---|
| Build/Types | Vite、TypeScript |
| Unit/Component | Vitest、Testing Library、jsdom |
| API Mock | MSW |
| E2E | Playwright |
| Contract Generation | openapi-typescript、openapi-fetch |
| Static Quality | ESLint、typescript-eslint |

## 6. Interfaces & Data Contracts

### 6.1 Mission API

| 方法 | 路径 | 语义 | 成功状态 |
|---|---|---|---|
| GET | `/api/v1/health/live` | 进程存活 | 200 |
| GET | `/api/v1/health/ready` | DB 与组合根可用 | 200/503 |
| GET | `/api/v1/missions` | 分页获取匿名开发用户的任务列表 | 200 |
| POST | `/api/v1/missions` | 创建任务并提交第一条消息 | 201 |
| GET | `/api/v1/missions/{mission_id}` | 获取当前任务投影 | 200 |
| GET | `/api/v1/missions/{mission_id}/candidates` | 获取当前版本候选集 | 200 |
| GET | `/api/v1/missions/{mission_id}/recommendation` | 获取当前已验证推荐 | 200/404 |
| POST | `/api/v1/missions/{mission_id}/messages` | 追加消息并启动新运行 | 202 |
| PATCH | `/api/v1/missions/{mission_id}/constraints` | 显式修改预算、市场、偏好或库存条件 | 202 |
| POST | `/api/v1/missions/{mission_id}/undo` | 撤销最近一次可撤销条件变更并产生新版本 | 202/409 |
| PUT | `/api/v1/missions/{mission_id}/comparison` | 替换 2–4 件比较集合 | 200 |
| GET | `/api/v1/missions/{mission_id}/events` | 获取 SSE 任务事件 | 200 stream |
| GET | `/api/v1/product-snapshots/{snapshot_id}` | 获取可展示的标准化商品详情 | 200 |

所有 Mission 接口要求 `X-Anonymous-User-ID` UUID，用于开发态数据隔离；前端首次访问时生成并保存该值。它不是认证凭据，生产环境不得据此授权。所有写操作接受可选 `Idempotency-Key`。同一 owner/key 与相同请求指纹重试返回首次响应；相同 key 对应不同指纹返回 `409 idempotency_key_reused`。PATCH、undo 和 comparison 请求必须包含客户端已知的 `constraints_version`；版本冲突返回 `409 mission_version_conflict`。任务列表只返回当前匿名 ID 的任务，使用 `limit`、`offset`，默认 `limit=20`、最大 `100`，按 `updated_at DESC, id ASC` 稳定排序。

### 6.2 ShoppingMission 投影

```json
{
  "id": "uuid",
  "title": "通勤降噪耳机",
  "stage": "ready",
  "constraints_version": 3,
  "constraints": {
    "query": "通勤降噪耳机",
    "budget_cny": 2500,
    "markets": ["US", "SG"],
    "preference": "balanced",
    "only_in_stock": false
  },
  "active_run_id": "uuid",
  "candidate_set_id": "uuid",
  "comparison_snapshot_ids": ["uuid", "uuid"],
  "recommendation_run_id": "uuid",
  "warnings": [],
  "created_at": "2026-08-16T08:00:00Z",
  "updated_at": "2026-08-16T08:00:03Z"
}
```

`stage` 只允许：`collecting`、`clarifying`、`searching`、`ranking`、`ready`、`degraded`、`failed`。

### 6.3 ProductCandidate ViewModel

```json
{
  "snapshot_id": "uuid",
  "source": "buywhere",
  "source_product_id": "497937424",
  "title": "Sony WH1000XM5 Wireless Noise Cancelling Headphones",
  "merchant": "shopify",
  "market": "US",
  "native_price": {"amount": 499.99, "currency": "USD"},
  "estimated_cny": {
    "amount": 3594.03,
    "rate": 7.1882,
    "source": "frankfurter-ecb",
    "rate_date": "2026-08-15",
    "fetched_at": "2026-08-16T08:00:01Z"
  },
  "fx_failed": false,
  "brand": null,
  "rating": null,
  "review_count": null,
  "availability": "unknown",
  "specs": [],
  "derived_fields": [],
  "unavailable_fields": ["brand", "rating", "review_count", "availability", "specs"],
  "merchant_url": "https://example.com/product",
  "source_updated_at": "2026-06-16T17:59:33.930Z",
  "rank": 1,
  "decision_reasons": ["within_budget", "lowest_estimated_cny"]
}
```

规则：

- `estimated_cny` 在 FX 失败时为 `null`，商品仍可保留但必须排在可换算商品之后。
- `fx_failed` 只表示本轮无法取得该币种汇率，不表示商品或原币价格无效。
- `availability` 只允许 `in_stock`、`limited`、`out_of_stock`、`unknown`；无证据时必须为 `unknown`。
- `merchant_url` 必须是快照中的 HTTPS URL 或 `null`。
- 前端不得从 `title` 自行推导品牌、规格或库存；若后端使用确定性解析，字段名必须进入 `derived_fields`，ProductSnapshot 必须保留解析规则版本。本骨架默认不做此推导。

### 6.4 IntentPatch

```json
{
  "query": null,
  "budget_cny": 2000,
  "markets": null,
  "preference": "battery",
  "only_in_stock": null,
  "confidence": 0.98,
  "source": "deterministic",
  "requires_clarification": false,
  "clarification_question": null
}
```

### 6.5 RecommendationDraft 与最终响应

模型或模板只可生成：

```json
{
  "primary_snapshot_id": "uuid",
  "alternative_snapshot_ids": ["uuid"],
  "rationale": ["在当前可检索结果中商品价估算较低"],
  "tradeoffs": ["库存信息未提供，需要在商户页确认"],
  "cited_evidence_ids": ["uuid", "uuid"]
}
```

后端必须验证 ID 后重新读取快照，构造包含完整价格事实的最终 `RecommendationResponse`。任何不存在于快照或领域决策记录中的断言都必须删除。

### 6.6 Error Contract

```json
{
  "error": {
    "code": "fx_unavailable",
    "category": "upstream",
    "message": "人民币估算暂不可用，已保留原币价格。",
    "retryable": true,
    "degraded_result_available": true,
    "trace_id": "uuid",
    "details": {}
  }
}
```

`category` 只允许 `user`、`upstream`、`model`、`data`、`system`、`security`。

### 6.7 SSE Event Contract

```text
id: 12
event: candidates.ranked
data: {"mission_id":"uuid","run_id":"uuid","constraints_version":3,"candidate_set_id":"uuid","count":8}
```

允许事件：`run.accepted`、`clarification.required`、`search.started`、`products.received`、`fx.received`、`candidates.ranked`、`recommendation.ready`、`run.degraded`、`run.superseded`、`run.failed`。

## 7. 可机械执行的开发方案

### 7.1 执行总规则

1. 严格按 P0 → P7 顺序执行。
2. 每个工作包先增加或更新测试，再实现代码。
3. 每个阶段结束执行该阶段门禁并保存命令输出；失败时停止，不进入下一阶段。
4. 不删除或覆盖当前未提交的 `frontend/src/App.tsx`、`styles.css` 和新增后端切片；迁移时逐文件移动并用测试证明行为保持。
5. 每个阶段只允许一个架构事实源；新规格生效后同步更新旧文档中的目录和现状表。
6. 禁止为了通过测试而回填真实 API 不存在的字段。
7. 一个工作包只能处于 `pending`、`in_progress`、`passed`、`blocked` 四种状态之一；同时最多一个工作包为 `in_progress`。
8. `passed` 必须附直接证据，不能用“代码看起来完成”“其他测试通过”代替本工作包门禁。

### 7.2 执行台账

P0-W02 必须创建 `docs/project-skeleton-execution.md`，并为 P0-W01 至 P7-W02 预生成行。每完成一次操作即更新台账，不在最后集中补写。

```md
| Work package | State | Started at | Finished at | Change/commit | Commands | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| P0-W01 | in_progress | 2026-08-16T08:00:00Z | | working tree | `make baseline` | | |
```

台账规则：

- 时间使用 UTC ISO 8601。
- `Commands` 记录实际执行命令，不记录计划命令。
- `Evidence` 链接 JUnit、coverage、Playwright 报告、迁移输出或可复现 API fixture。
- 发现规格缺陷时先把当前工作包标记 `blocked`，修订规格并记录版本，再恢复执行。
- 用户未授权提交时，`Change/commit` 写工作树路径和 diff 摘要，不擅自提交。

### 7.3 阶段门禁命令矩阵

P0-W02 创建的 Makefile 必须实现下列目标；目标内部命令可以随工具配置调整，但语义不得改变。

| 阶段 | 必须执行 | 证明范围 |
|---|---|---|
| P0 | `make baseline` | 旧后端测试、前端 build、diff check、secret precheck。 |
| P1 | `make backend-unit backend-contract architecture` | 领域、Port、供应商契约和依赖方向。 |
| P2 | `make migrate-test backend-integration` | 迁移往返、Repository 和事务。 |
| P3 | `make agent-test` | 图节点、路由、降级和版本竞争。 |
| P4 | `make api-test contract-drift` | HTTP/SSE、错误契约和 OpenAPI。 |
| P5 | `make frontend-check` | lint、typecheck、unit/component、build。 |
| P6 | `make check e2e` | 全量无 Key CI 等价门禁。 |
| P7 | `make acceptance` | 从空库到闭环的最终机械验收。 |

### P0：基线冻结与工程入口

#### P0-W01 保护当前基线

- 执行 `git status -sb`、`git diff --check`、后端离线测试和前端构建。
- 记录当前通过基线：29 个后端测试，前端 `npm run build` 成功。
- 检查 `.env` 已忽略且没有 Key 被 Git 跟踪。
- 若执行者有提交权限，创建一个明确的基线提交；否则保存完整 `git diff --stat` 并保持所有改动不丢失。

门禁：当前测试和构建必须通过，`git diff --check` 无错误。

#### P0-W02 统一项目元数据

修改或创建：

- `README.md`：项目定位、边界、快速启动、模式切换、测试命令。
- `pyproject.toml`：修正遗留的 game recommendation 描述和 marker；添加后续阶段依赖组。
- `.gitignore`：忽略 `.env`、缓存、覆盖率、Playwright 报告和本地验收产物。
- `.env.example`：只给出变量名和安全示例。
- `Makefile`：提供 `help`、`bootstrap`、`baseline`、`db-up`、`db-down`、`migrate`、`migrate-test`、`backend-dev`、`frontend-dev`、`backend-unit`、`backend-contract`、`backend-integration`、`architecture`、`agent-test`、`api-test`、`contract-drift`、`frontend-check`、`lint`、`test`、`e2e`、`check`、`acceptance`。
- `compose.yaml`：仅包含 PostgreSQL；Redis 不在本阶段出现。
- `docs/project-skeleton-execution.md`：按 §7.2 创建完整工作包台账。

环境变量最小集合：

```text
INTEREC_ENV=development
INTEREC_DATA_SOURCE=fixture
INTEREC_DATABASE_URL=postgresql+asyncpg://interec:interec@localhost:5432/interec
INTEREC_BUYWHERE_API_KEY=
INTEREC_LLM_PROVIDER=unconfigured
INTEREC_LOG_LEVEL=INFO
VITE_DATA_SOURCE=api
VITE_API_BASE_URL=http://localhost:8000/api/v1
VITE_ENABLE_DEMO_AUTH=false
```

门禁：`make bootstrap` 可重复执行；README 中所有基础命令与 Makefile 一致。

### P1：后端分层迁移与异步端口

#### P1-W01 建立 Domain 与 Application 边界

- 保留并迁移现有 `NormalizedProduct`、`FxSnapshot`、过滤、去重和排序测试。
- 将纯领域规则放入 `backend/domain/policies/`。
- 在 `backend/application/ports/` 定义异步 `MissionRunner`、`RunDispatcher`、`ProductSource`、`FxSource`、`ModelBackend`、Repository 和 UnitOfWork 协议。
- Port 返回标准 DTO，不暴露 `httpx.Response`、ORM Model 或 BuyWhere Pydantic Model。
- HTTP `MissionCommandService` 只依赖 `RunDispatcher` Port；Application 包中禁止导入 `backend.agent` 和 `backend.infrastructure`。
- 为依赖规则增加架构测试。

门禁：领域单测全部通过；架构测试证明 `backend/domain` 不导入外层包。

#### P1-W02 迁移基础设施实现

- 将当前 `backend/adapters/buywhere.py` 迁入 `infrastructure/product_sources/buywhere.py`，改为 `httpx.AsyncClient`。
- 将当前 FX Adapter 迁入 `infrastructure/fx_sources/frankfurter.py`，保留汇率日期与 TTL 行为。
- 新增 fixture 商品源和 fixed FX 源；两者读取脱敏测试 fixture。
- 401 不重试；429 遵守 `Retry-After`；5xx/网络错误有限重试；重试次数和超时来自 Settings。
- 多市场搜索使用受限并发，结果按市场输入顺序和稳定商品键归并，避免并发导致排序随机。

门禁：现有真实响应 fixture 契约测试通过；新增超时、429、部分市场失败和无价格用例通过。

#### P1-W03 建立组合根

- `bootstrap/settings.py` 是唯一环境读取点。
- `bootstrap/container.py` 根据 Settings 构造共享 AsyncClient、数据源、服务和 UnitOfWork。
- Fixture/Live 切换只发生在 container。
- CLI 与 FastAPI 使用同一个 container，不各自复制装配逻辑。

门禁：无 Key Fixture Mode 可运行 CLI；Live Mode 缺 Key 时启动失败信息明确且不泄露变量值。

### P2：PostgreSQL 业务事实与迁移

#### P2-W01 建立 ORM 与首个迁移

- 增加 SQLAlchemy 2 async、asyncpg 和 Alembic。
- 建立七张核心表及外键、唯一约束和时间字段。
- `shopping_missions(id, owner_id, stage, constraints_json, constraints_version, active_run_id, created_at, updated_at)`。
- `mission_events(id, mission_id, sequence, event_type, payload_json, created_at)`。
- `product_snapshots(id, source, source_product_id, contract_version, raw_json, normalized_json, fetched_at)`。
- `fx_snapshots(id, base, quote, rate, source, rate_date, fetched_at)`。
- `candidate_sets(id, mission_id, run_id, constraints_version, candidates_json, created_at)`。
- `recommendation_runs(id, mission_id, candidate_set_id, status, draft_json, final_json, created_at, completed_at)`。
- `idempotency_records(id, owner_id, idempotency_key, request_fingerprint, response_status, response_json, expires_at, created_at)`。
- `recommendation_runs.candidate_set_id` 在候选生成前允许为空，完成或降级提交时必须非空；失败/中断运行允许为空。
- 为 `owner_id + updated_at + id`、`mission_id + sequence`、`source + source_product_id + fetched_at`、`mission_id + constraints_version` 建索引，并为 `owner_id + idempotency_key` 建唯一约束。

门禁：空数据库 `alembic upgrade head` 成功；`downgrade base` 后再次升级成功；七张表及约束存在；模型 metadata 与迁移无漂移。

#### P2-W02 Repository 与事务测试

- Repository 只返回领域/应用 DTO。
- 创建任务与第一条事件在一个事务提交。
- 更新条件时使用版本条件更新，冲突抛 `MissionVersionConflict`。
- CandidateSet 和 RecommendationRun 提交前再次校验版本。

门禁：集成测试证明事件与版本原子性、冲突返回、回滚不留下半条记录。

### P3：ShoppingMission Agent 状态图

#### P3-W01 定义状态和节点契约

- 分离持久化业务状态 `ShoppingMission` 与短生命周期 `MissionGraphState`。
- 实现 `LangGraphMissionRunner(MissionRunner)`；具体 runner 只在 Bootstrap 注入 `InProcessRunDispatcher`，再把 dispatcher 注入 MissionCommandService。
- 为每个节点定义输入/输出 TypedDict 或 Pydantic 模型。
- 建立节点注册表只用于可替换节点，不为每个普通函数增加无价值抽象。
- 图构建集中在 `agent/graph.py`。

门禁：图结构快照测试通过；非法阶段转换被拒绝；Application/Agent 导入图无环。

#### P3-W02 实现确定性基础路径

顺序实现并逐节点测试：

1. `receive_message`
2. `parse_intent_patch`
3. `merge_mission_state`
4. `need_clarification`
5. `build_search_plan`
6. `fetch_products`
7. `fetch_fx`
8. `normalize_and_deduplicate`
9. `filter_hard_constraints`
10. `rank_candidates`
11. `verify_evidence`
12. `compose_recommendation`
13. `persist_decision_snapshot`

确定性解析器至少覆盖预算、市场、耳机/显示器/徒步鞋查询、价格优先、续航优先、降噪优先和仅看有货。数据不支持库存或续航时，偏好必须降级为“当前数据无法按该维度排序”，而不是使用 mock。

门禁：Fixture Mode 图测试覆盖正常、追问、无结果、FX 失败、部分市场失败和旧版本 superseded。

#### P3-W03 LLM 接缝

- 实现 `UnconfiguredModelBackend`，任何调用都返回明确的 capability unavailable，而不是抛未处理异常。
- 定义结构化 `IntentPatch` 与 `RecommendationDraft` Schema。
- 真实 LLM Provider 在用户确认首选供应商后作为独立提交加入；不得修改领域和 API 契约。

门禁：无 LLM Key 的完整 Agent 图仍通过全部骨架验收。

### P4：FastAPI BFF 与 SSE

#### P4-W01 API Shell

- 实现 app factory、lifespan、共享资源关闭、CORS 开发配置、trace middleware 和统一异常映射。
- 实现 live/ready 健康检查。
- OpenAPI 固定标题、版本和 `/api/v1` 前缀。

门禁：API TestClient/AsyncClient 测试覆盖启动、关闭、健康检查、trace_id 和错误契约。

#### P4-W02 Mission Commands

- 按 §6.1 实现任务创建、读取、消息、约束、比较集合和商品快照接口。
- 实现任务列表、候选集读取、推荐读取和显式 undo；Mission View 不从内部数据库表自行拼接状态。
- API route 只调用 Application Service；不得导入 `backend.agent`、ORM Repository 或供应商实现。
- 所有写操作验证 idempotency、输入长度、市场枚举、预算范围和比较数量。
- 所有 Mission 查询和命令按 `X-Anonymous-User-ID` 隔离；跨 owner ID 读取统一返回 404，避免泄漏资源存在性。
- 写操作返回 `run_id` 与当前 `constraints_version`。

门禁：OpenAPI 契约测试通过；任务分页稳定；2–4 件比较边界、undo、版本冲突和不存在资源测试通过。

#### P4-W03 SSE Events

- 实现受 FastAPI lifespan 管理的 `InProcessRunDispatcher`；它调用注入的 `MissionRunner`，不使用 FastAPI BackgroundTasks。
- Run 在调度前持久化为 `accepted`；执行时为 `running`；完成时为 `completed/degraded/failed/superseded`。
- 优雅关闭先停止接收新 Run，在配置的 grace period 内 drain；剩余任务取消并记录 `interrupted`。启动恢复服务将遗留的 `accepted/running` 标记为 `interrupted`，前端可以显式重试。
- 先将运行事件持久化为 `mission_events`，再推送给连接客户端。
- SSE 从 PostgreSQL 增量读取事件并发送，默认轮询间隔不高于 500ms，每 15 秒发送 heartbeat；因此多连接不依赖进程内事件内存。
- 支持 `Last-Event-ID` 或 `after` 参数恢复。
- 断线不取消已接受运行；重连可看到最终结果。

门禁：集成测试模拟调度、优雅关闭、遗留 Run 恢复和 SSE 断线重连；事件不重复、不倒序，最终 mission 投影一致。

### P5：前端契约冻结与模块化迁移

#### P5-W01 API ViewModel 优先

- 从 FastAPI OpenAPI 生成 `api/generated.ts` 并提交。
- 定义手写的窄接口 `MissionApi`，隔离生成代码细节。
- 实现 `fixture.ts`、`client.ts` 和 `factory.ts`。
- 使用 MSW 模拟与真实 API 一致的状态转换，而不是直接读取旧 `products` 数组。

门禁：相同契约测试分别运行在 fixture/client mock 上；生成类型无漂移。

#### P5-W02 拆分 App.tsx

按以下顺序迁移，每次只移动一组并保持构建通过：

1. 类型和纯函数到 `api/`、`lib/`。
2. 通用按钮、图标、平台标记到 `components/ui/`。
3. 价格证据和缺失字段组件到 `components/evidence/`。
4. Home、Mission、Compare、Mission List 到 `views/`。
5. 对话、候选、比较、商品详情到各 `features/`。
6. Provider、QueryClient、路由和 Error Boundary 到 `app/`。
7. 模拟登录隔离到 `features/demo-auth/`。

不得在迁移中重新设计视觉；先保持现有交互，再单独优化。

门禁：每一步 `typecheck + unit test + build` 通过；最终 `App.tsx` 只负责应用壳与路由，不包含商品数据和业务算法。

#### P5-W03 接入任务 API

- Home 创建任务后导航到 `/missions/{id}`。
- Mission View 使用 Query 获取投影，并通过 SSE 或轮询 fallback 更新运行状态。
- 预算/偏好/库存条件通过 API command 更新，不直接改本地任务对象。
- Compare 集合通过服务端保存，刷新后恢复。
- Product Detail 只渲染 API 提供的标准化字段。

门禁：浏览器刷新后任务、候选和比较集合恢复；API 缺少评分/规格/库存时不出现 mock 值。

### P6：测试体系、架构门禁与 CI

#### P6-W01 后端自动化

- Unit：domain policies、IntentPatch、排序稳定性、证据校验。
- Contract：BuyWhere、Frankfurter、API Schema、fixture source。
- Integration：PostgreSQL Repository、事务、FastAPI、SSE。
- Architecture：禁止反向导入和供应商类型泄漏。
- Live：真实 Key 的受控搜索、详情、比较和汇率冒烟。

门禁：覆盖率满足 QLT-004，所有测试可按 marker 独立运行。

#### P6-W02 前端自动化

- Unit：格式化、状态映射、字段缺失规则。
- Component：商品卡、价格证据、错误/降级、比较边界。
- Integration：MSW 驱动 Mission View 和 Compare View。
- E2E：创建任务、收到推荐、修改预算、选择比较、刷新恢复、打开商户链接提示。

门禁：测试无固定延时，使用可观察状态等待；核心定位器使用 role/name/test-id 稳定约定。

#### P6-W03 CI

CI 至少包含：

1. `backend-quality`：ruff、mypy、architecture tests、unit/contract tests。
2. `backend-integration`：PostgreSQL service、迁移、integration tests。
3. `frontend-quality`：lint、typecheck、unit/component、build。
4. `contract-drift`：导出 OpenAPI、生成 TS 类型并检查 Git diff 为空。
5. `fixture-e2e`：启动 Postgres、FastAPI Fixture Mode、Vite build/preview、Playwright。

Live Smoke 不读取普通 PR Secret，不作为 fork PR 阻断项。

门禁：从干净 checkout、无第三方 Key 环境中全部通过。

### P7：最终验收与文档收敛

#### P7-W01 机械验收

执行：

```bash
make bootstrap
make db-up
make migrate
make check
make acceptance
```

`make acceptance` 必须：

- 启动 Fixture Mode 后端与前端。
- 执行 Playwright 核心闭环。
- 导出 JUnit/HTML 测试报告和一次任务的脱敏事件/快照证据。
- 检查数据库迁移状态。
- 检查 OpenAPI/TypeScript 契约漂移。
- 输出 PASS/FAIL 和失败工作包 ID。

#### P7-W02 文档与遗留项

- 更新 README 快速启动。
- 更新技术架构和目录设计，使其与实际目录一致。
- 将当前实现状态写入 `docs/implementation-status.md`。
- 记录未决项：真实 LLM Provider、真实认证、Redis/Celery、数据丰富来源、配送能力。
- 删除已被替代的重复说明，或明确标记历史文档和新文档优先级。

最终门禁：第 8 节所有验收条件有直接证据，无“规划中”功能被描述为已实现。

## 8. Acceptance Criteria

- **AC-001 / BUS-001**：Given 无第三方 Key且 PostgreSQL 已启动，When 用户创建“通勤降噪耳机，预算 2500 元，US/SG”，Then 系统创建任务、运行 Agent、返回候选或明确无结果，并可在刷新后恢复。
- **AC-002 / BUS-004**：Given 候选存在人民币估算，When 前端显示价格，Then 同时显示原币、估算人民币、FX 来源和日期，并显示运费税费边界。
- **AC-003 / DAT-003**：Given BuyWhere 未提供 rating/specs/availability，When API 和前端渲染该商品，Then 对应字段为 null/unknown 或隐藏，页面不得出现 mock 数据。
- **AC-004 / BUS-005**：Given 用户选择 1、2、4、5 件候选，When 保存比较集合，Then 1 和 5 返回校验错误，2 和 4 成功且刷新后保持。
- **AC-005 / AGT-005**：Given V3 运行未完成且用户提交 V4 预算，When V3 随后完成，Then V3 标记 superseded，V4 仍是任务当前结果。
- **AC-006 / BE-004**：Given US 搜索超时而 SG 成功，When 运行搜索，Then 返回 SG 候选、degraded 状态和 US 警告，不返回整轮 500。
- **AC-007 / BUS-004**：Given FX 服务失败，When 搜索成功，Then 保留原币商品，`estimated_cny=null`，人民币预算过滤不错误排除这些商品，并显示汇率不可用。
- **AC-008 / BE-005**：Given BuyWhere 401、429、5xx，When Adapter 处理响应，Then 分别映射为稳定错误码，401 不重试，429/5xx 按策略处理且无 Key 泄漏。
- **AC-009 / AGT-004**：Given RecommendationDraft 引用不存在的商品或证据 ID，When 后端校验，Then 该推荐被拒绝或删除断言，最终响应不包含虚构事实。
- **AC-010 / ARC-001**：Given 执行架构检查，When 扫描导入图，Then domain 不依赖 api/application agent/infrastructure，application/agent 不依赖具体 BuyWhere/Frankfurter/ORM 实现。
- **AC-011 / FE-006**：Given 用户完成任务后刷新页面，When 浏览器重新加载，Then任务从后端恢复而不是依赖旧 `localStorage` 任务对象。
- **AC-012 / OBS-003**：Given SSE 在事件 4 后断线，When 客户端携带最后事件 ID 重连，Then 从事件 5 继续且最终状态一致。
- **AC-013 / QLT-002**：Given 干净 checkout 且无真实 Key，When CI 执行，Then后端、前端、迁移、契约和 fixture E2E 全部通过。
- **AC-014 / SEC-001**：Given 扫描 Git 跟踪文件和日志 fixture，When 检查 Key/Authorization，Then 不存在真实密钥或完整认证头。
- **AC-015 / BUS-008**：Given 用户修改预算后撤销，When读取任务事件和投影，Then约束版本继续单调递增，任务恢复到变更前业务值且审计事件完整。
- **AC-016 / BE-009**：Given 一个 Run 已返回 202 且处于 running，When 服务进入优雅关闭并超过 grace period，Then Run 被记录为 interrupted、事件可恢复、前端可显式重试；执行链路不使用 FastAPI BackgroundTasks。
- **AC-017 / BE-010**：Given 同一匿名 owner 以相同 Idempotency-Key 重复提交相同创建任务请求，When 第二次请求到达，Then 返回首次响应且只存在一个 Mission/首事件/Run；若 payload 不同则返回 409。

### 8.1 Requirement-to-Evidence Traceability

下表中的证据名是执行阶段必须创建的测试或机械检查。测试文件可以按最终目录细分，但名称、覆盖语义和对应 Requirement 不得丢失。

| Requirement | 实现工作包 | 必须形成的直接证据 |
|---|---|---|
| BUS-001 | P2-W02, P4-W02, P5-W03 | `test_create_get_resume_mission`；`test_anonymous_owner_isolation`；Playwright `mission-create-resume` |
| BUS-002 | P3-W02 | `test_parse_intent_patch_table`；`test_unknown_query_asks_one_question` |
| BUS-003 | P1-W02, P4-W02 | `test_supported_markets`；`test_country_code_is_not_delivery` |
| BUS-004 | P1-W02, P3-W02, P5-W03 | AC-002、AC-007；`price-evidence` component test |
| BUS-005 | P4-W02, P5-W03 | AC-004；Playwright `compare-two-to-four` |
| BUS-006 | P3-W02 | `test_recommendation_contains_verified_primary_alternatives_tradeoffs` |
| BUS-007 | P5-W02 | `test_purchase_boundary_copy`；E2E 商户跳转提示断言 |
| BUS-008 | P2-W02, P4-W02 | AC-015；`test_hard_constraint_not_relaxed` |
| ARC-001 | P1-W01, P6-W01 | AC-010；`test_import_boundaries` |
| ARC-002 | P1-W01, P3-W01 | 架构扫描：Agent 节点无 Infrastructure/SDK import |
| ARC-003 | P1-W01 | mypy 通过；Port/DTO contract tests 无裸供应商 dict |
| ARC-004 | P2-W01 | `test_persisted_timestamps_are_utc` |
| ARC-005 | P2-W01 | `test_internal_ids_are_uuid_and_source_id_is_separate` |
| ARC-006 | P1-W03 | `test_settings_is_only_environment_reader` |
| ARC-007 | P1-W03, P5-W01 | `test_container_switches_sources`；MissionApi 双实现契约测试 |
| AGT-001 | P3-W01, P3-W02 | `test_graph_has_required_nodes_and_routes` |
| AGT-002 | P3-W01 | 节点 input/output schema tests；未知字段拒绝测试 |
| AGT-003 | P3-W03 | ModelBackend structured output schema tests |
| AGT-004 | P3-W02 | AC-009；`test_final_response_rehydrates_snapshot_facts` |
| AGT-005 | P2-W02, P3-W02 | AC-005；`test_superseded_run_cannot_commit` |
| AGT-006 | P3-W02, P3-W03 | `test_full_graph_without_llm_key` |
| BE-001 | P4-W01 | `test_health_and_versioned_openapi` |
| BE-002 | P1-W01 | `test_required_ports_exist_and_are_async` |
| BE-003 | P1-W02 | `test_shared_async_client_timeout_and_retry_policy` |
| BE-004 | P1-W02 | AC-006；`test_market_concurrency_is_bounded` |
| BE-005 | P4-W01 | AC-008；`test_error_contract_and_trace_id` |
| BE-006 | P2-W01 | 迁移 upgrade/downgrade/upgrade；禁止 `create_all` 架构检查 |
| BE-007 | P4-W02 | `test_api_never_returns_raw_payload` |
| BE-008 | P3-W02, P4-W02 | `test_merchant_url_must_be_snapshot_https_url` |
| BE-009 | P1-W01, P4-W03 | AC-016；`test_dispatcher_lifecycle_and_interrupted_recovery`；禁止 BackgroundTasks 架构扫描 |
| BE-010 | P2-W01, P2-W02, P4-W02 | AC-017；`test_idempotency_replay_and_fingerprint_conflict` |
| FE-001 | P5-W02 | 路由/视图 smoke tests；Playwright 核心闭环 |
| FE-002 | P5-W01, P5-W03 | 组件依赖扫描；View tests 只注入 MissionApi |
| FE-003 | P5-W01 | `mission-api.contract.test.ts` 对 fixture/client 双实现运行 |
| FE-004 | P5-W02, P5-W03 | AC-003；`product-missing-facts.test.tsx` |
| FE-005 | P5-W03 | `mission-async-states.test.tsx` 覆盖五种状态 |
| FE-006 | P5-W03 | AC-011；localStorage 键白名单检查 |
| FE-007 | P5-W03 | AC-004；组件 1/2/4/5 边界测试 |
| FE-008 | P5-W02, P6-W02 | Testing Library a11y query tests；E2E 禁止 CSS 路径定位检查 |
| DAT-001 | P2-W01 | migration schema assertion 七表与幂等唯一约束齐全 |
| DAT-002 | P2-W01, P2-W02 | `test_product_snapshot_roundtrip_and_contract_version` |
| DAT-003 | P1-W01, P5-W02 | AC-003；标准化和渲染测试 |
| DAT-004 | P3-W02 | `test_candidate_set_records_inclusion_exclusion_and_rank_inputs` |
| DAT-005 | P2-W02 | `test_event_and_version_commit_atomically`；rollback test |
| DAT-006 | P4-W01, P4-W02 | API schema assertion；日志捕获测试不含 raw payload |
| SEC-001 | P0-W02, P6-W03 | AC-014；secret scan；`.env.example` 检查 |
| SEC-002 | P3-W03, P4-W02 | 输入长度/URL allowlist/不可信文本隔离测试 |
| SEC-003 | P4-W01 | `test_sensitive_log_redaction` |
| OBS-001 | P4-W01, P4-W02 | `test_trace_id_propagation_and_run_id_generation` |
| OBS-002 | P3-W02, P4-W01 | 结构化日志 schema test，覆盖成功和错误节点 |
| OBS-003 | P4-W03 | AC-012；SSE sequence/reconnect tests |
| QLT-001 | P0-W02, P7-W01 | `make help` 目标检查；所有 Make target 实际执行 |
| QLT-002 | P6-W03 | AC-013；CI fixture-e2e job |
| QLT-003 | P6-W01, P6-W03 | `live` marker 默认 skip；手动 workflow 请求预算检查 |
| QLT-004 | P6-W01, P6-W02 | CI coverage threshold 直接失败门禁 |
| QLT-005 | P1–P5 | 提交记录/执行日志显示 contract/acceptance test 先于实现通过 |
| QLT-006 | P0–P7 | 每阶段门禁报告，失败工作包不得标记完成 |

## 9. Test Automation Strategy

### 9.1 测试层级与框架

| 层级 | 后端 | 前端 | 外部依赖 |
|---|---|---|---|
| Unit | pytest、pytest-asyncio | Vitest | 无 |
| Contract | pytest、respx、JSON fixture | Vitest、MSW | 脱敏 fixture |
| Integration | FastAPI AsyncClient、PostgreSQL | Testing Library、MSW | 本地 PostgreSQL |
| E2E | FastAPI Fixture Mode | Playwright | PostgreSQL + fixture source |
| Live Smoke | pytest `live` marker | 不要求 | BuyWhere + Frankfurter |

### 9.2 必测故障矩阵

| 场景 | 必须证明 |
|---|---|
| 无结果 | 明确 empty，不自动放宽预算或型号。 |
| 无价格商品 | 跳过或标记不可比较并记录计数，不伪造 0。 |
| FX 失败 | 保留原币，人民币为空，任务 degraded。 |
| 单市场失败 | 其他市场结果保留。 |
| 401 | 不重试，不泄露 Key。 |
| 429 | 读取 Retry-After，有限重试或返回可恢复错误。 |
| 5xx/超时 | 有限重试，最终使用可用部分或明确失败。 |
| 字段漂移 | 可选字段降级；必需容器/类型错误触发契约错误。 |
| 旧任务回写 | 版本校验阻止。 |
| SSE 断线 | 可恢复、不重复。 |
| LLM 非法结构 | Schema 阻止，fallback 可用。 |
| 虚构证据 ID | 最终响应校验阻止。 |

### 9.3 测试数据管理

- Fixture 必须脱敏并保留供应商响应形态。
- 时间、UUID、汇率和随机排序在测试中固定。
- E2E 每个用例使用独立 mission，不依赖执行顺序。
- Integration 测试在事务或独立 schema 中隔离，结束后自动清理。
- Live 测试只记录字段统计和脱敏 ID，不提交完整用户数据或密钥。

### 9.4 覆盖率与质量

- Domain/Application：语句覆盖率 ≥ 85%，分支覆盖率建议 ≥ 75%。
- Backend Overall：语句覆盖率 ≥ 75%。
- Frontend 核心业务模块：语句覆盖率 ≥ 70%。
- 覆盖率不能替代 AC-001 至 AC-017 的场景验收。

### 9.5 性能基线

- Fixture Mode 单任务 API 完成 P95 < 1 秒。
- Live Mode 首次搜索目标 P95 < 3 秒；若供应商无法满足，记录供应商耗时并以 SSE 呈现进度，不伪造指标。
- 多市场并发必须有请求预算和最大并发配置。

## 10. Rationale & Context

当前前端已经验证了任务工作区、候选、比较和账号交互，但事实来自单文件 mock；当前后端已经验证 BuyWhere 搜索、Frankfurter 汇率、预算过滤和排序，但尚无 API、任务状态、持久化或前端连接。直接在现有 `App.tsx` 上接原始 BuyWhere 响应会把供应商字段缺失扩散到整个 UI；直接在现有 `service.py` 中加入 LangGraph、数据库和 FastAPI会形成无法测试的混合层。

因此本规格先冻结 ViewModel 和 Port，再迁移现有可用代码。Fixture Mode 使普通开发和 CI 不依赖额度、网络或密钥；Live Mode 继续证明真实数据接入。PostgreSQL 在骨架阶段引入，是因为任务版本、事件、快照和推荐证据是产品核心，不是后期可随意补上的实现细节。Redis/Celery 被延后，是因为骨架尚无跨进程锁或提醒任务的真实需求。

## 11. Dependencies & External Integrations

### External Systems

- **EXT-001**：BuyWhere REST API——商品搜索、详情、比较和价格历史；骨架首先使用搜索，其他端点保留 Adapter 能力但不强制进入主链路。
- **EXT-002**：Frankfurter/ECB——原币到人民币汇率，要求返回汇率日期且无 Key。

### Infrastructure Dependencies

- **INF-001**：PostgreSQL——业务任务、事件和证据事实源；本地由 Compose 启动。
- **INF-002**：文件系统 fixture——无网测试数据，不作为生产业务事实源。

### Technology Platform Dependencies

- **PLT-001**：Python 3.12+、uv、FastAPI、Pydantic v2、httpx async、SQLAlchemy 2 async、Alembic、LangGraph。
- **PLT-002**：Node.js LTS、React 18、TypeScript、Vite、TanStack Query、Vitest、MSW、Playwright。

### Deferred Dependencies

- **DEF-001**：真实 LLM Provider——需要用户确认 OpenAI Responses、DeepSeek/OpenAI-compatible 或其他供应商。
- **DEF-002**：Redis/Celery——价格提醒或分布式任务出现后引入。
- **DEF-003**：认证供应商——真实用户系统另立安全规格。

## 12. Examples & Edge Cases

### 12.1 部分成功

```text
输入：sony wh1000xm5，预算 4000，市场 US,SG
US：429
SG：返回 6 件
FX：SGD→CNY 成功

期望：
- mission.stage = degraded
- 返回 SG 可用候选
- warnings 包含 US rate_limited
- 不声称覆盖全部市场
- 不重试用户消息，不产生重复 CandidateSet
```

### 12.2 汇率失败

```text
商品：USD 299
FX：超时

期望：
- native_price 保留
- estimated_cny = null
- fx_failed = true
- 预算过滤不把商品错误判定为超预算
- 排序时位于可换算商品之后
```

### 12.3 字段缺失

```text
BuyWhere 返回 title/price/merchant/url，没有 rating/stock/specs

期望：
- API 的 rating = null, availability = unknown, specs = []
- unavailable_fields 明确列出缺失字段
- UI 不显示星级、评价数和“有货”
- 推荐理由只能使用价格、市场、商户、更新时间等已有证据
```

### 12.4 条件竞争

```text
V2 搜索运行中
用户将预算改为 2000，生成 V3
V2 晚于 V3 返回

期望：
- V2 RecommendationRun = superseded
- Mission 仍指向 V3 CandidateSet/RecommendationRun
- SSE 发出 run.superseded
```

## 13. Validation Criteria

规格合规必须同时满足：

1. 目录与依赖满足 ARC-001 至 ARC-007，架构测试有直接证据。
2. AC-001 至 AC-017 全部存在自动化测试或明确的机械检查证据。
3. `make acceptance` 在干净 checkout、无第三方 Key 环境通过。
4. Live Mode 在提供 Key 时通过最少请求冒烟；未提供 Key 时正确跳过而非失败。
5. 前端 API 模式不出现 BuyWhere 未提供的 mock 评分、库存、规格或品牌事实。
6. 数据库从空库迁移、降级和再次升级均成功。
7. OpenAPI 与前端生成类型无漂移。
8. README、技术架构、目录设计和实现状态与代码一致。
9. Git 跟踪文件、日志和验收产物不包含密钥或完整认证信息。
10. 所有“已实现”声明都有代码、测试或运行产物支撑；规划项明确标记为 deferred。

## 14. Related Specifications / Further Reading

- [跨境购物 Agent 产品需求](../docs/cross-border-shopping-agent-prd.md)
- [技术架构与技术选型](../docs/technical-architecture-and-selection.md)
- [项目目录设计](../docs/project-directory-design.md)
- [BuyWhere 真实链路验证报告](../docs/buywhere-adapter-verification.md)
