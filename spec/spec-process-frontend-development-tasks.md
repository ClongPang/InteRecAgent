---
title: Frontend Testable Development Task Breakdown
version: 1.0
date_created: 2026-07-07
last_updated: 2026-07-07
owner: Frontend Team
tags: [process, frontend, react, testing, recommendation-agent]
---

# Introduction

本规格定义 InteRecAgent MVP 前端的可测试开发任务拆分。目标是让前端开发者或生成式 AI 编码代理能够按依赖顺序实现 React 前端，并为每个任务提供清晰的接口契约、验收标准和自动化测试要求。

## 1. Purpose & Scope

本规格覆盖 React + Vite + TypeScript 前端、API 类型契约、消费者购物工作区、产品推荐卡片、Agent 工作流面板、澄清与反馈交互、内部 trace 页面、评测 dashboard、响应式布局和自动化测试。

本规格不覆盖 FastAPI 后端实现、推荐算法、数据管道、LLM 调用、真实支付、实时库存、真实登录鉴权和线上部署。

目标读者包括前端开发者、测试工程师、产品设计负责人和生成式 AI 编码代理。假设后端通过 JSON API 提供 `ChatTurnResponse`、`ProductRecommendation`、`TraceSummary` 和评测结果；前端在后端不可用时必须能使用 mock fixture 独立开发和测试。

## 2. Definitions

- **MVP**: Minimum Viable Product，最小可演示产品。
- **UI**: User Interface，用户界面。
- **API**: Application Programming Interface，前后端通信接口。
- **LLM**: Large Language Model，大语言模型。
- **Consumer Workspace**: 面向普通用户的购物对话和推荐结果界面。
- **Internal View**: 面向开发和评测的内部 trace、回放和评测界面。
- **ChatTurnResponse**: 后端对单轮聊天请求返回的统一结构化响应。
- **ProductRecommendation**: 后端提供的商品推荐卡片数据。
- **TraceSummary**: 消费者 UI 可展示的安全工作流摘要。
- **InternalTrace**: 内部页面可展示的完整追踪数据。
- **Feedback Anchor**: 用户反馈关联的商品或 turn，例如 `anchor_product_id`。
- **Fixture**: 用于本地测试和 mock 渲染的确定性样例数据。

## 3. Requirements, Constraints & Guidelines

### 3.1 Global Requirements

- **REQ-001**: 前端必须使用 React + Vite + TypeScript，并启用严格类型检查。
- **REQ-002**: 前端必须由统一 `ChatTurnResponse` 驱动，不得创建页面专属的临时响应格式。
- **REQ-003**: 前端只渲染后端提供的商品事实、证据、约束状态和工作流摘要，不得推断推荐真相。
- **REQ-004**: 消费者路由必须呈现 `Chat + Results + Agent Workflow Panel` 的主工作区。
- **REQ-005**: 内部路由必须与消费者路由分离，不得在消费者 UI 展示完整 trace、原始用户行为或完整长期画像。
- **REQ-006**: 所有用户可触发操作必须具备 loading、success、empty、unsupported 和 recoverable error 状态。
- **REQ-007**: 每个前端任务必须提交或更新自动化测试；没有测试的任务不得标记为完成。
- **REQ-008**: 前端必须支持 mock fixture 开发，使 UI 测试不依赖 live 后端。

### 3.2 Constraints

- **CON-001**: 前端不得声称支持实时库存、配送、支付、结账或网页实时搜索。
- **CON-002**: 价格、品牌、图片、评论、评分、matched tags、constraint status 和 uncertainty notes 必须来自后端 payload。
- **CON-003**: 错误状态不得展示 stack trace、API key、原始 prompt、完整内部 trace 或敏感 profile 数据。
- **CON-004**: 反馈动作必须携带 `session_id`、`turn_id` 和必要的 `anchor_product_id`，不得只发送按钮标签。
- **CON-005**: 响应式布局不得隐藏主要输入框、推荐结果、澄清操作或错误恢复操作。

### 3.3 Frontend Task Slices

| ID | Task | Dependencies | Required Deliverable | Required Automated Tests |
|---|---|---|---|---|
| FE-001 | 创建 React + Vite + TypeScript 骨架 | None | `frontend/` 项目、基础 scripts、空应用可启动 | smoke render test |
| FE-002 | 定义 API 类型和共享模型 | FE-001, BE-002 | `ChatTurnResponse`、`ProductRecommendation`、`TraceSummary`、`IntentState` 类型 | type fixture compilation test |
| FE-003 | 实现 API client 和 mock fixture 层 | FE-002, BE-004 | chat、products、traces、evaluation client；可切换 mock/live | client success/error tests |
| FE-004 | 实现消费者主布局 | FE-001 | Chat + Results + Workflow Panel 框架 | layout render and landmark tests |
| FE-005 | 实现聊天线程、输入框和提交状态 | FE-003, FE-004 | 用户消息、助手消息、composer、pending 状态 | interaction tests |
| FE-006 | 渲染 mock `ChatTurnResponse` 状态 | FE-002, FE-005 | recommendation、clarification、unsupported、error、feedback-updated 状态 | fixture-driven state tests |
| FE-007 | 实现 `ProductRecommendation` 卡片列表 | FE-002, FE-006 | 标题、图片/fallback、价格/unknown、类目、标签、评分、证据 | card rendering tests |
| FE-008 | 实现简化 `AgentWorkflowPanel` | FE-002, FE-006 | task、intent、clarification、retrieval、filtering、ranking、evidence 摘要 | trace summary tests |
| FE-009 | 实现澄清提示组件 | FE-006 | options、free answer、skip、recommend-anyway 操作 | clarification interaction tests |
| FE-010 | 实现反馈 chips 和 anchor 请求 | FE-007 | cheaper、avoid brand、more portable、custom feedback 等动作 | request payload tests |
| FE-011 | 渲染反馈更新结果和 `IntentState` diff | FE-010 | "what changed" 区域、变更字段、更新原因 | diff display tests |
| FE-012 | 渲染证据、缺失证据和 unknown 状态 | FE-007, FE-008 | supported evidence、missing evidence、unknown attribute、constraint unknown | edge-state tests |
| FE-013 | 实现商品证据 drawer | FE-007, BE-005 | 商品事实、证据、unknown 字段、反馈动作 | drawer accessibility tests |
| FE-014 | 实现局部 comparison table | FE-007, FE-016 | 2-4 个候选的约束、证据、unknown、建议选择对比 | table rendering tests |
| FE-015 | 实现内部 trace console | FE-003, BE-022 | turn selector、stage detail、raw trace JSON、error list | internal route tests |
| FE-016 | 实现评测 dashboard | FE-003, BE-023 | 五项指标、golden cases、失败 drilldown | metric and drilldown tests |
| FE-017 | 实现系统状态页面/组件 | FE-006 | loading、empty、error、unsupported、clarification limit | state component tests |
| FE-018 | 完成响应式、可访问性和视觉 QA | FE-004 to FE-017 | desktop/tablet/mobile 稳定布局；键盘与 ARIA 可用 | Playwright and a11y tests |

### 3.4 Testable Development Workflow

- **DEV-001**: 每个任务必须先定义 fixture、组件测试或交互测试，再实现 UI。
- **DEV-002**: 组件不得直接调用 `fetch`；必须通过 API client 或 hook，便于 mock。
- **DEV-003**: 复杂视图必须先支持 fixture 渲染，再接入真实 API。
- **DEV-004**: 修改公共 TypeScript 类型时，必须同步更新 mock fixture、API client 测试和相关组件测试。
- **DEV-005**: 涉及布局的任务必须至少验证 desktop 和 mobile 两类 viewport。
- **DEV-006**: 涉及内部页面的任务必须验证消费者路由不会泄露内部 trace 字段。

### 3.5 Definition of Done

| Completion Item | Requirement |
|---|---|
| Source code | 模块位于 `frontend/src/` 的约定目录，组件名使用 PascalCase |
| Type safety | `npm run typecheck` 通过，无 `any` 绕过核心 API 契约 |
| Unit/component tests | 覆盖成功、失败、空态和边界状态 |
| Interaction tests | 用户输入、提交、澄清、反馈和重试路径可自动验证 |
| Accessibility | 核心控件有可访问名称，键盘可操作，错误可读 |
| Responsive QA | 主要视图在 desktop、tablet、mobile 不遮挡主要操作 |
| Mockability | 页面可在无后端时使用 fixture 渲染 |
| Local validation | `npm test`、`npm run typecheck` 和相关 E2E 命令通过 |

## 4. Interfaces & Data Contracts

### 4.1 Frontend Routes

| Route | Audience | Purpose | Data Source |
|---|---|---|---|
| `/` | Consumer | 购物对话、推荐结果、简化工作流摘要 | `POST /api/chat` |
| `/internal/trace` | Internal | 查看完整 turn trace、阶段详情和错误 | `GET /api/internal/traces/{turn_id}` |
| `/internal/eval` | Internal | 查看评测运行、五项指标和失败 case | `POST /api/evaluation/run`, `GET /api/evaluation/runs/{run_id}` |

### 4.2 Backend API Usage

| Method | Path | Frontend Use |
|---|---|---|
| GET | `/api/health` | 可选健康检查和开发环境提示 |
| POST | `/api/chat` | 提交用户消息、澄清回答、反馈请求 |
| GET | `/api/sessions/{session_id}` | 恢复会话摘要 |
| GET | `/api/products/{product_id}` | 商品 drawer 事实补充 |
| GET | `/api/internal/traces/{turn_id}` | 内部 trace console |
| POST | `/api/evaluation/run` | 启动内部评测 |
| GET | `/api/evaluation/runs/{run_id}` | 读取评测 dashboard |

### 4.3 TypeScript Contract Examples

```ts
type ChatTurnStatus =
  | "clarification_required"
  | "recommendations_ready"
  | "unsupported"
  | "partial_support"
  | "error";

interface ChatTurnResponse {
  session_id: string;
  turn_id: string;
  status: ChatTurnStatus;
  task_type: string;
  message: string;
  intent_state: IntentState;
  products: ProductRecommendation[];
  clarification?: ClarificationPayload;
  comparison?: ComparisonPayload;
  unsupported?: UnsupportedPayload;
  trace_summary: TraceSummary;
  suggested_actions: SuggestedAction[];
}
```

```ts
interface ProductRecommendation {
  product_id: string;
  title: string;
  brand?: string | null;
  price?: number | null;
  currency?: string;
  image_url?: string | null;
  category_path: string[];
  leaf_category?: string;
  average_rating?: number | null;
  review_count?: number;
  matched_tags: string[];
  evidence: EvidenceItem[];
  uncertainties: string[];
  constraint_status: "satisfied" | "violated" | "unknown";
  constraint_checks?: ConstraintCheck[];
  score_breakdown?: Record<string, number>;
  rank_reason?: string;
  rank: number;
}
```

```ts
interface FeedbackRequest {
  session_id: string;
  turn_id: string;
  feedback_text: string;
  feedback_type?: string;
  anchor_product_id?: string;
}
```

### 4.4 UI State Model

```text
idle
  -> submitting
  -> clarifying | recommending | unsupported | ready | error
  -> updating_from_feedback
```

Pipeline loading labels must use consumer-safe text:

```text
Understanding request
Checking catalog
Verifying constraints
Ranking candidates
Preparing answer
```

## 5. Acceptance Criteria

- **AC-001**: Given 新前端项目, When 运行本地开发命令, Then 应用启动并渲染空的消费者工作区。
- **AC-002**: Given 后端 schema fixture, When TypeScript 类型和 fixture 编译, Then `ChatTurnResponse`、`ProductRecommendation`、`TraceSummary` 与契约一致。
- **AC-003**: Given recommendation fixture, When 打开消费者工作区, Then 页面显示聊天消息、推荐商品卡片和工作流摘要。
- **AC-004**: Given clarification fixture, When 用户选择选项、输入自由回答、skip 或 recommend-anyway, Then 前端发送合法请求并更新状态。
- **AC-005**: Given unsupported fixture, When 用户请求 checkout、live inventory 或 shipping, Then UI 明确说明不支持并提供 catalog-backed 替代操作。
- **AC-006**: Given 商品价格或证据缺失, When 渲染商品卡片, Then UI 显示 `unknown` 或 evidence missing，不得展示推断价格或证据。
- **AC-007**: Given 用户点击 feedback chip, When 请求发送, Then payload 包含 `session_id`、`turn_id`、`feedback_text`、`feedback_type` 和对应 `anchor_product_id`。
- **AC-008**: Given feedback-updated fixture, When 渲染更新结果, Then UI 显示 "what changed" 和相关 `IntentState` diff。
- **AC-009**: Given internal trace fixture, When 访问 `/internal/trace`, Then 页面展示完整阶段详情；When 访问 `/`, Then 不展示 raw trace JSON。
- **AC-010**: Given evaluation run fixture, When 访问 `/internal/eval`, Then dashboard 显示五项核心指标和失败 case drilldown。
- **AC-011**: Given API error, When chat 请求失败, Then UI 保留用户输入上下文，显示可恢复错误和 retry 路径。
- **AC-012**: Given mobile viewport, When 渲染主工作区, Then composer、推荐结果和主要操作不重叠、不被遮挡。

## 6. Test Automation Strategy

- **Test Levels**: Type tests, unit tests, component tests, API client tests, route integration tests, end-to-end tests, accessibility checks, responsive visual smoke tests.
- **Frameworks**: Vitest, React Testing Library, MSW or equivalent request mocking, Playwright, TypeScript compiler, axe-compatible accessibility checks.
- **Test Data Management**: Store deterministic mock payloads under `frontend/src/test/fixtures/` or `frontend/tests/fixtures/`. Fixtures must include recommendation, clarification, unsupported, error, feedback-updated, unknown, evidence-missing, trace, and evaluation cases.
- **CI/CD Integration**: Default frontend validation should run `npm run typecheck`, `npm test`, and non-live Playwright smoke tests. Live backend tests must be separately marked.
- **Coverage Requirements**: Product cards, feedback requests, clarification UI, workflow panel, API client, error handling, and internal route isolation should have branch coverage for normal and edge states.
- **Performance Testing**: MVP requires only local smoke thresholds: initial fixture render should complete quickly, and loading states should appear while async requests are pending. Full load testing is out of scope.

### 6.1 Required Test Command Matrix

| Scope | Command | Expected Use |
|---|---|---|
| Type safety | `npm run typecheck` | Run before marking any frontend task complete |
| Unit/component tests | `npm test` | Run during regular development |
| Watch mode | `npm run test:watch` | Local TDD loop |
| E2E smoke tests | `npm run test:e2e` | Validate primary user flows |
| Accessibility tests | `npm run test:a11y` | Validate keyboard and ARIA expectations |
| Production build | `npm run build` | Validate bundling and type-safe production output |

### 6.2 Suggested Test Directory Layout

```text
frontend/
  src/
    api/
    types/
    features/
      chat/
      recommendation/
      agentTrace/
      evaluation/
      fallback/
    layouts/
    test/
      fixtures/
      mocks/
      render.tsx
  tests/
    e2e/
    accessibility/
```

## 7. Rationale & Context

InteRecAgent 的前端不是普通商品列表页面，而是可解释、可追踪、可反馈的推荐工作台。前端必须让用户看到推荐结果和简化工作流，同时避免暴露内部 trace 和原始行为画像。测试先行的任务拆分可以让 UI 在后端尚未完整实现时通过 fixture 独立开发，并在后端契约稳定后快速切换到真实 API。

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: FastAPI backend - 提供 chat、products、trace 和 evaluation JSON API。

### Third-Party Services

- **SVC-001**: Browser runtime - 前端必须支持现代桌面和移动浏览器。

### Infrastructure Dependencies

- **INF-001**: Local dev server - 用于运行 Vite 前端开发环境。
- **INF-002**: Mock service layer - 用于无后端的组件和 E2E 测试。

### Data Dependencies

- **DAT-001**: Backend API fixtures - 必须覆盖所有 `ChatTurnStatus` 和主要商品边界状态。
- **DAT-002**: Prototype reference - `docs/prototype/index.html` 作为状态覆盖和视觉方向参考，不作为生产代码来源。

### Technology Platform Dependencies

- **PLT-001**: Node.js frontend runtime - 必须支持 React、Vite、TypeScript、Vitest 和 Playwright。
- **PLT-002**: HTTP JSON API - 所有后端集成使用 JSON contract。

### Compliance Dependencies

- **COM-001**: Data minimization - 消费者 UI 不得展示原始用户行为、完整长期画像或内部 trace。
- **COM-002**: Secret handling - API keys、service tokens 和私有配置不得写入前端源码或 fixture。

## 9. Examples & Edge Cases

### 9.1 Mock ChatTurnResponse Fixture Example

```json
{
  "session_id": "sess_demo",
  "turn_id": "turn_001",
  "status": "recommendations_ready",
  "task_type": "single_item_recommendation",
  "message": "I found catalog-backed options under your budget.",
  "intent_state": {"category": "wireless headphones", "budget": {"max": 100, "currency": "USD"}},
  "products": [],
  "trace_summary": {
    "turn_id": "turn_001",
    "task_type": "single_item_recommendation",
    "intent_summary": {},
    "clarification_decision": {"should_clarify": false},
    "retrieved_count": 80,
    "filtered_count": 12,
    "ranking_summary": {},
    "rerank_summary": {},
    "evidence_sources": ["metadata", "reviews"],
    "warnings": []
  },
  "suggested_actions": []
}
```

### 9.2 Required Edge Cases

- Price is `null` under a budget request: render unknown and do not show "under budget".
- Product image is missing: render stable image fallback without layout shift.
- Evidence array is empty: show evidence missing state and avoid unsupported quality claims.
- Clarification limit reached: show recommend-anyway or edit-request path.
- API timeout: keep the user's draft or latest message visible and provide retry.
- Internal trace contains raw profile: ensure it appears only in `/internal/trace`, never in `/`.
- Mobile viewport: workflow panel must collapse or move without hiding chat composer.

## 10. Validation Criteria

- **VAL-001**: `frontend/` contains React + Vite + TypeScript skeleton before FE-001 is complete.
- **VAL-002**: `npm run typecheck` passes before any frontend task is marked complete.
- **VAL-003**: `npm test` passes with mock fixtures and no live backend dependency.
- **VAL-004**: Every `ChatTurnStatus` has at least one fixture and one rendering test.
- **VAL-005**: Feedback actions are tested for correct `FeedbackRequest` payload shape.
- **VAL-006**: Product cards are tested for missing image, missing price, missing evidence and unknown constraint states.
- **VAL-007**: Consumer route tests verify raw internal trace and raw profile fields are not rendered.
- **VAL-008**: Internal trace and evaluation routes have route-level tests.
- **VAL-009**: Playwright smoke tests cover initial recommendation, clarification, feedback update and unsupported fallback flows.
- **VAL-010**: Desktop and mobile viewports pass layout smoke tests without hidden primary actions.

## 11. Related Specifications / Further Reading

- [Backend Testable Development Task Breakdown](./spec-process-backend-development-tasks.md)
- [Implementation Task Breakdown](../docs/implementation_task_breakdown.md)
- [System Architecture](../docs/system_architecture.md)
- [MVP Scope](../docs/mvp_scope.md)
- [Review Meeting Consensus](../docs/review_meeting_consensus.md)
- [Static Prototype](../docs/prototype/index.html)
- [Repository Guidelines](../AGENTS.md)
