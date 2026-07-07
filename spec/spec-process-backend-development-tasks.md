---
title: Backend Testable Development Task Breakdown
version: 1.0
date_created: 2026-07-07
last_updated: 2026-07-07
owner: Backend Team
tags: [process, backend, fastapi, testing, recommendation-agent]
---

# Introduction

本规格定义 InteRecAgent MVP 后端的可测试开发任务拆分。目标是让开发者或生成式 AI 编码代理能够按依赖顺序实现后端模块，并为每个任务提供明确的接口、验收标准和自动化测试要求。

## 1. Purpose & Scope

本规格覆盖 FastAPI 后端、Pydantic 数据契约、数据管道、商品检索、约束校验、排序、会话状态、智能体流程、LLM 适配、追踪日志、评测服务和回放工具。

本规格不覆盖 React 前端实现、视觉设计、真实支付、实时库存、线上部署和数据版权处理。

目标读者包括后端开发者、测试工程师、产品技术负责人和生成式 AI 编码代理。假设项目使用 Python、FastAPI、Pydantic 和 pytest；LLM 能力必须通过可替换适配器接入，并支持 mock 或缓存模式。

## 2. Definitions

- **MVP**: Minimum Viable Product，最小可演示产品。
- **API**: Application Programming Interface，后端对外提供的 HTTP 接口。
- **LLM**: Large Language Model，大语言模型。
- **IntentState**: 当前会话中结构化的用户购物意图。
- **ChatTurnResponse**: `POST /api/chat` 返回的单轮结构化响应。
- **ProductRecommendation**: 推荐商品卡片的后端事实载体。
- **TraceSummary**: 面向消费者或前端工作流面板的安全摘要。
- **InternalTrace**: 面向开发和评测的完整内部追踪记录。
- **Golden Case**: 用于回归评测的标注 JSONL 样例。
- **Hard Constraint**: 用户明确要求且不能违反的条件，例如预算上限或排除品牌。
- **Evidence**: 来自商品元数据、评论、评分或内部画像的可追溯依据。

## 3. Requirements, Constraints & Guidelines

### 3.1 Global Requirements

- **REQ-001**: 后端必须提供 FastAPI 应用骨架，并以 `/api` 作为业务接口前缀。
- **REQ-002**: 所有入站请求和出站响应必须使用 Pydantic schema 校验。
- **REQ-003**: 商品事实必须来自本地商品目录、评论证据或内部画像；不得由 LLM 生成。
- **REQ-004**: 每个聊天 turn 必须写入 trace，至少包含路由、意图、澄清、检索、过滤、排序、响应和反馈信息。
- **REQ-005**: 所有 LLM 相关模块必须支持 `mock`、`cached` 和 `live` 三种运行模式。
- **REQ-006**: 每个开发任务必须同时提交或更新自动化测试；没有测试的任务不得标记为完成。
- **REQ-007**: 最终推荐列表不得包含已确认违反 Hard Constraint 的商品。
- **REQ-008**: 缺失字段必须显式标记为 `unknown`，不得省略或伪造。

### 3.2 Constraints

- **CON-001**: MVP 不支持实时库存、配送、结账、价格抓取或网页实时搜索。
- **CON-002**: 前端只渲染后端结构化数据，不推断商品事实、约束状态或推荐理由。
- **CON-003**: 原始用户行为画像只能用于后端内部信号，不得暴露给消费者接口。
- **CON-004**: LLM reranker 只能重排已通过最终校验的候选集合，不得恢复被过滤商品。
- **CON-005**: 连续澄清次数不得超过 3 次；总对话轮次达到 5 次前必须尝试推荐或安全降级。

### 3.3 Backend Task Slices

| ID | Task | Dependencies | Required Deliverable | Required Automated Tests |
|---|---|---|---|---|
| BE-001 | FastAPI 骨架和健康检查 | None | `GET /api/health` | API contract test |
| BE-002 | Pydantic schema 契约 | BE-001 | `IntentState`、`ChatTurnResponse` 等核心模型 | schema fixture validation |
| BE-003 | Trace logger 与 JSONL 存储 | BE-002 | 可追加写入和按 `turn_id` 读取 trace | unit and file-store tests |
| BE-004 | Mock chat endpoint | BE-002, BE-003 | `POST /api/chat` 返回稳定 mock 响应 | API state tests |
| BE-005 | Product store 与商品查询 API | BE-002 | `GET /api/products/{product_id}` | found, not found, unknown-field tests |
| BE-006 | Embedding text 与向量索引构建 | DATA-004 | 可从商品构建可检索索引 | deterministic small-index test |
| BE-007 | Retriever service | BE-006 | top-K 商品 ID 和检索分数 | unit ranking-order test |
| BE-008 | Constraint verifier | BE-005, BE-007 | `satisfied`、`violated`、`unknown_*` 标签 | branch tests for each state |
| BE-009 | Rule ranker | BE-008 | 分数明细和排序结果 | score breakdown tests |
| BE-010 | Final validator | BE-008, BE-009 | 过滤硬约束违规商品 | hard-violation exclusion tests |
| BE-011 | Session state manager | BE-002, BE-003 | 消息、意图、推荐历史、反馈历史 | state transition tests |
| BE-012 | Task router | BE-011 | 任务类型、置信度、理由 | labeled fixture tests |
| BE-013 | Intent parser baseline | BE-012 | 可更新 `IntentState` | slot extraction tests |
| BE-014 | Clarification policy | BE-013, BE-007 | 澄清决策和问题 | limit and ambiguity tests |
| BE-015 | Feedback updater | BE-011, BE-013 | `intent_before`、`intent_after` 和更新原因 | feedback diff tests |
| BE-016 | Chat orchestrator | BE-007, BE-010, BE-014, BE-015 | 固定 pipeline 的真实 chat flow | integration golden tests |
| BE-017 | OpenAI-compatible LLM adapter | BE-002 | schema 校验、mock、cached、live 模式 | adapter mode tests |
| BE-018 | LLM intent parsing option | BE-017, BE-013 | LLM 输出校验和 baseline fallback | invalid JSON fallback tests |
| BE-019 | LLM reranker | BE-017, BE-010 | 仅重排 safe top-N | no-restored-violation tests |
| BE-020 | Grounded response generator | BE-017, BE-005 | 证据绑定的回答和商品卡片 | unsupported-claim tests |
| BE-021 | Claim-level evidence records | BE-020 | claim 到 evidence 的映射 | evidence coverage tests |
| BE-022 | Full trace API | BE-003, BE-016 | `GET /api/internal/traces/{turn_id}` | auth-free internal contract test for MVP |
| BE-023 | Evaluation runner API | BE-012, BE-013, BE-016, BE-021 | 运行五项核心指标 | JSON report tests |
| BE-024 | Replay runner baseline | BE-003, BE-016 | 按固定配置回放历史 turn | deterministic replay test |

### 3.4 Data Pipeline Task Slices

| ID | Task | Dependencies | Required Deliverable | Required Automated Tests |
|---|---|---|---|---|
| DATA-001 | Amazon metadata loader | BE-002 | 标准化商品记录 | parser fixture tests |
| DATA-002 | Review loader 和证据抽取 baseline | BE-002 | 评论与商品 ID 关联，生成证据片段 | join and snippet tests |
| DATA-003 | Data quality report | DATA-001, DATA-002 | 价格、图片、品牌、类目、评论覆盖率 | report schema tests |
| DATA-004 | Curated demo pool | DATA-003 | 演示商品池，优先完整商品 | selection rule tests |

### 3.5 Guidelines

- **GUD-001**: 每个 service 保持单一职责，并放在 `backend/app/services/` 或相应子目录。
- **GUD-002**: Store、LLM adapter 和 vector index 必须可依赖注入，便于测试替换。
- **GUD-003**: 测试 fixture 必须小而确定，避免依赖完整原始数据集。
- **GUD-004**: API 错误必须返回稳定 JSON 结构：`code`、`message`、`details`。
- **GUD-005**: 新增任务完成时必须更新相关 schema fixture、golden case 或评测样例。

### 3.6 Testable Development Workflow

- **DEV-001**: 每个任务必须先定义至少一个失败测试或可复现验收 fixture，再实现代码。
- **DEV-002**: 每个任务的最小完成单位是“接口或 service 可调用 + 自动化测试通过 + trace 或错误行为明确”。
- **DEV-003**: 单元测试不得依赖网络、完整 Amazon 原始数据、live LLM、真实向量库服务或前端进程。
- **DEV-004**: 涉及 LLM 的任务必须先完成 mock mode 测试，再补 cached mode 测试；live mode 只允许作为手动或标记测试。
- **DEV-005**: 涉及排序、检索、回放和评测的测试必须使用固定 fixture，并保证重复运行结果稳定。
- **DEV-006**: 如果一个任务改动公共 schema，必须同步更新 API contract test、fixture 和本规格相关字段。

### 3.7 Definition of Done

| Completion Item | Requirement |
|---|---|
| Source code | 模块位于约定目录，命名与任务 ID 对应能力一致 |
| Unit tests | 覆盖主要成功路径、失败路径和边界条件 |
| API tests | 涉及 endpoint 的任务必须覆盖 HTTP status、响应 schema 和错误结构 |
| Fixtures | 新增或更新 `tests/fixtures/` 中的最小样例 |
| Trace | 涉及 pipeline 的任务必须写入可检查 trace 字段 |
| Documentation | 公共契约变化必须更新 spec 或 docs |
| Local validation | `python3 -m pytest` 或对应任务测试命令通过 |

## 4. Interfaces & Data Contracts

### 4.1 HTTP Endpoints

| Method | Path | Purpose | Response Contract |
|---|---|---|---|
| GET | `/api/health` | 服务健康检查 | `HealthResponse` |
| POST | `/api/chat` | 执行单轮推荐、澄清、反馈或降级 | `ChatTurnResponse` |
| GET | `/api/sessions/{session_id}` | 读取会话摘要 | `SessionState` |
| GET | `/api/products/{product_id}` | 查询商品事实 | `ProductRecord` |
| GET | `/api/internal/traces/{turn_id}` | 查询完整内部 trace | `InternalTrace` |
| POST | `/api/evaluation/run` | 运行评测集 | `EvaluationRunSummary` |
| GET | `/api/evaluation/runs/{run_id}` | 读取评测结果 | `EvaluationRunSummary` |
| POST | `/api/internal/replay` | 回放已记录 turn | `ReplayResult` |

### 4.2 Core Schema Example

```json
{
  "IntentState": {
    "task_type": "single_item_recommendation",
    "category": "wireless mouse",
    "goal": "office use",
    "scenario": "daily work",
    "budget": {"max": 100, "currency": "USD"},
    "brand_preference": [],
    "price_sensitivity": "medium",
    "priority_order": ["comfort", "battery"],
    "hard_constraints": [{"field": "price", "op": "<=", "value": 100}],
    "soft_preferences": ["quiet click"],
    "negative_preferences": [],
    "target_user": "self",
    "uncertainty_fields": [],
    "feedback_history": [],
    "long_term_profile": {}
  }
}
```

```json
{
  "ChatTurnResponse": {
    "session_id": "sess_001",
    "turn_id": "turn_001",
    "response_type": "recommendation",
    "assistant_message": "Here are grounded recommendations.",
    "intent_state": {},
    "recommendations": [],
    "clarification": null,
    "workflow_summary": {},
    "errors": []
  }
}
```

### 4.3 Evaluation Output Contract

```json
{
  "run_id": "eval_001",
  "timestamp": "2026-07-07T00:00:00Z",
  "metrics": {
    "task_type_accuracy": 0.0,
    "intent_slot_f1": 0.0,
    "constraint_satisfaction": 0.0,
    "evidence_coverage": 0.0,
    "feedback_recovery": 0.0
  },
  "case_failures": []
}
```

## 5. Acceptance Criteria

- **AC-001**: Given 新仓库环境, When 运行后端应用并请求 `GET /api/health`, Then 返回 HTTP 200 且 JSON 包含服务状态。
- **AC-002**: Given schema fixture, When 使用 Pydantic 加载, Then 所有合法 fixture 通过校验且非法 fixture 返回明确错误。
- **AC-003**: Given mock chat 请求, When 调用 `POST /api/chat`, Then 返回 `recommendation`、`clarification`、`unsupported` 和 `feedback_updated` 中的合法响应类型。
- **AC-004**: Given 带预算上限的用户意图, When 执行 constraint verifier 和 final validator, Then 超预算商品不得进入最终推荐。
- **AC-005**: Given 缺失价格或属性的商品, When 生成商品卡片, Then 响应必须包含 `unknown` 状态和不确定性说明。
- **AC-006**: Given 品牌拒绝反馈, When feedback updater 更新意图, Then `negative_preferences` 包含该品牌且下一轮检索不优先返回该品牌。
- **AC-007**: Given LLM 返回非法 JSON, When LLM intent parser 或 reranker 执行, Then 系统使用 baseline fallback 或返回可恢复错误，不写入脏状态。
- **AC-008**: Given 一条完整 chat turn, When pipeline 执行结束, Then trace store 中可按 `turn_id` 查到完整内部 trace。
- **AC-009**: Given golden cases, When 调用评测 runner, Then 输出五项核心指标和失败样例列表。
- **AC-010**: Given 已记录 turn 和固定配置, When replay runner 执行, Then 输出与基准一致的 pipeline 阶段结果。

## 6. Test Automation Strategy

- **Test Levels**: Unit tests for services and schemas; API contract tests for FastAPI endpoints; integration tests for chat orchestrator; evaluation tests for golden cases; replay regression tests for trace stability.
- **Frameworks**: `pytest`, FastAPI `TestClient`, Pydantic validation, temporary directories for file stores, monkeypatch or dependency injection for LLM and vector index.
- **Test Data Management**: Store small deterministic fixtures under `tests/fixtures/`. Store evaluation JSONL under `data/eval/` only when it is safe to commit. Raw Amazon data must not be required for normal unit tests.
- **CI/CD Integration**: The default validation command must be `python3 -m pytest`. Long-running tests should use pytest markers such as `integration`, `eval`, or `slow`.
- **Coverage Requirements**: Constraint verifier, final validator, feedback updater, trace logger, and schema validation should have branch coverage for success and failure paths. MVP backend modules should target at least 80% line coverage once implemented.
- **Performance Testing**: MVP must include a small smoke test ensuring a fixture-backed chat turn completes within a local deterministic threshold. Full load testing is out of scope.

### 6.1 Required Test Command Matrix

| Scope | Command | Expected Use |
|---|---|---|
| All deterministic tests | `python3 -m pytest` | Run before marking any backend task complete |
| API contract tests | `python3 -m pytest tests/api/` | Run after adding or changing endpoints |
| Service unit tests | `python3 -m pytest tests/services/` | Run during individual module development |
| Data pipeline tests | `python3 -m pytest tests/data_pipeline/` | Run when loaders, reports, or demo pool selection change |
| Evaluation tests | `python3 -m pytest tests/evaluation/` | Run when metrics or golden cases change |
| Non-slow CI subset | `python3 -m pytest -m "not slow and not live_llm"` | Use as the default CI gate when markers exist |

### 6.2 Suggested Test Directory Layout

```text
tests/
  api/
    test_health.py
    test_chat.py
    test_products.py
    test_internal_traces.py
  services/
    test_task_router.py
    test_intent_parser.py
    test_constraint_verifier.py
    test_ranker.py
    test_feedback_updater.py
  data_pipeline/
    test_metadata_loader.py
    test_review_loader.py
    test_demo_pool.py
  evaluation/
    test_task_type_metric.py
    test_constraint_metric.py
    test_feedback_recovery_metric.py
  fixtures/
    products.json
    chat_requests.json
    golden_cases.jsonl
```

## 7. Rationale & Context

InteRecAgent 的核心价值不是生成流畅文本，而是执行可追踪、可评测、可纠错的推荐流程。因此后端任务必须按“契约优先、事实接地、约束安全、trace 可审计、评测可回归”的顺序开发。将任务拆成小切片可以让每个模块在没有完整前端或完整数据集的情况下独立验证。

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: Amazon Reviews 2018 / legacy 5-core metadata and reviews - 用于构建商品目录、评论证据和内部用户画像。

### Third-Party Services

- **SVC-001**: OpenAI-compatible LLM service - 用于可选的意图解析、重排和回答生成；必须可禁用或 mock。

### Infrastructure Dependencies

- **INF-001**: Local file storage - 用于 JSONL trace、fixture、评测输出和小规模 demo 数据。
- **INF-002**: Vector index storage - 用于商品 embedding 检索；测试环境必须支持内存或小文件替代。

### Data Dependencies

- **DAT-001**: Normalized product catalog - 必须包含 product ID、title、category、brand、price、attributes、image URL、rating 和 evidence snippets。
- **DAT-002**: Golden case JSONL - 必须覆盖简单推荐、澄清、预算约束、品牌拒绝、低价替代和不支持请求。

### Technology Platform Dependencies

- **PLT-001**: Python backend runtime - 必须支持 FastAPI、Pydantic 和 pytest。
- **PLT-002**: HTTP JSON API - 前后端集成和内部工具均使用 JSON contract。

### Compliance Dependencies

- **COM-001**: Secrets management - API keys 不得提交到仓库。
- **COM-002**: Data minimization - 原始用户行为和大规模原始数据不得通过消费者接口暴露。

## 9. Examples & Edge Cases

### 9.1 Golden Case JSONL Example

```json
{"case_id":"budget_mouse_001","user_message":"Recommend a wireless mouse under 100 dollars for office use.","expected_task_type":"single_item_recommendation","expected_intent":{"category":"wireless mouse","budget":{"max":100,"currency":"USD"}},"must_not_recommend":[{"field":"price","op":">","value":100}]}
```

### 9.2 Required Edge Cases

- Ambiguous category: user asks "I need something for work" and the system asks one clarifying question or safely recommends with uncertainty.
- Unknown price: product has no price and is shown only with `unknown` status, never as budget-satisfied.
- Brand rejection: user says "not Logitech" after a recommendation and next intent includes Logitech as a negative preference.
- Cheaper alternative: user asks for cheaper options and next recommendation prices are lower than the anchor when alternatives exist.
- Unsupported commerce action: user asks "buy it now" and system returns `unsupported` without pretending to complete checkout.
- Invalid LLM response: LLM emits malformed JSON and the backend falls back without corrupting session state.

## 10. Validation Criteria

- **VAL-001**: The file and directory layout includes `backend/app/`, `tests/`, and relevant `data/eval/` fixtures when implementation begins.
- **VAL-002**: `python3 -m pytest` passes before any backend task is marked complete.
- **VAL-003**: Every endpoint listed in Section 4 has at least one API contract test by the time its task is complete.
- **VAL-004**: Every schema in Section 4 has valid and invalid fixture tests.
- **VAL-005**: Hard-constraint violations are tested at verifier, validator, orchestrator, and evaluation levels.
- **VAL-006**: Trace output is generated for mock, real pipeline, feedback, unsupported, and error flows.
- **VAL-007**: Evaluation runner reports all five MVP metrics from JSONL golden cases.
- **VAL-008**: LLM live mode is never required for deterministic unit or CI tests.

## 11. Related Specifications / Further Reading

- [Implementation Task Breakdown](../docs/implementation_task_breakdown.md)
- [System Architecture](../docs/system_architecture.md)
- [MVP Scope](../docs/mvp_scope.md)
- [Evaluation Plan](../docs/evaluation_plan.md)
- [Repository Guidelines](../AGENTS.md)
