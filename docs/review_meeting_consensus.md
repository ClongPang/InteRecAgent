# InteRecAgent Review Meeting Consensus

**Date**: 2026-07-07  
**Meeting Type**: Multi-role product and architecture review  
**Shared Materials**: `docs/inte_rec_agent_prd.md`, `docs/mvp_scope.md`, `docs/system_architecture.md`, `docs/data_plan.md`, `docs/agent_architecture_and_tech_selection.md`, `docs/development_roadmap.md`, `docs/evaluation_plan.md`, `docs/prototype/index.html`

## Participants

| Role | Review Responsibility |
|---|---|
| Product Manager | Product scope, page walkthrough, MVP boundaries, acceptance criteria |
| Backend Architect | Agent pipeline, data stores, API contracts, trace, evaluation harness |
| Frontend Architect | React architecture, state model, API payload needs, UI states |
| Prototype Designer | Information architecture, page layout, interaction states, design acceptance |

## Final Meeting Position

InteRecAgent remains a **controlled agentic recommendation workflow**, not an autonomous shopping agent and not a plain LLM chatbot.

The agreed product center is:

```text
Catalog-backed shopping conversation
  + structured IntentState
  + constraint-safe recommendation pipeline
  + evidence-grounded product cards
  + visible agent workflow trace
  + feedback-driven recommendation update
```

The project should now move from static planning to an implementation-ready backlog. The next development phase must prioritize schemas, traceability, data quality, and API contracts before visual polish or complex LLM behavior.

## Second-Round Sign-Off

All four roles accepted the cross-review decisions. There were no blocking objections.

| Role | Final Sign-Off |
|---|---|
| Product Manager | Accepts backend schema/trace/constraint requirements, unified `ChatTurnResponse`, feedback anchors, and the revised main workspace with a workflow panel. |
| Backend Architect | Confirms the product, frontend, and prototype decisions are backend-supportable if API/schema contracts are frozen early and product facts remain backend-owned. |
| Frontend Architect | Accepts the revised MVP focus and requires backend-owned `matched_tags`, `evidence`, `uncertainties`, `constraint_status`, and workflow payloads. |
| Prototype Designer | Accepts the Consumer/Internal split and the `Chat + Results + Workflow Panel` baseline. |

Hard consensus:

- The frontend renders recommendation semantics; it does not infer them.
- Product facts, matched tags, evidence, constraint status, workflow copy, and feedback updates originate from structured backend payloads.
- Full trace and evaluation details are internal views; consumer UI receives a safe summary.

## Agreed MVP Scope

### Full Support

- Free-form shopping input.
- `single_item_recommendation`.
- `negative_feedback`.
- `alternative_recommendation`.
- Dynamic clarification with guardrails.
- Catalog-backed retrieval.
- Constraint verification before and after LLM rerank.
- Rule ranking plus safe LLM rerank.
- Evidence-grounded recommendation response.
- Product cards with title, image, price, category, matched tags, evidence, uncertainty.
- Feedback update loop with clear "what changed" explanation.
- Unsupported request graceful degradation.
- Main workflow panel or one-click workflow inspection.
- Five MVP evaluation scripts:
  - Task Type Accuracy
  - Intent Slot Accuracy
  - Constraint Satisfaction
  - Evidence Coverage
  - Feedback Recovery

### Partial Support

- Comparison: only compare 2-4 current recommended candidates or explicitly selected candidates from the current session.
- Gift recommendation: use only user-provided recipient context, budget, and interests; do not infer private recipient preferences.
- Product detail: light evidence drawer or detail page is useful, but the MVP release blocker is evidence-rich product cards.

### Unsupported or Graceful Fallback

- Checkout, payment, live inventory, live shipping, store availability, live web scraping.
- Full bundle optimization.
- Any claim that depends on missing or stale product facts.

## Product Manager Page Walkthrough

The Product Manager reviewed the current prototype and aligned each page with MVP support level.

| Page / State | Product Role | Support Level | Final Decision |
|---|---|---|---|
| Shopping assistant / Shopping workspace | Primary entry for free-form shopping requests and recommendation results | Full support | Keep as the default consumer route, but revise layout to `Chat + Results + Workflow Panel` |
| Clarification | Ask one high-value question when missing information would materially change recommendation quality | Full support | Render as an in-chat turn with options, free answer, skip, and recommend-anyway |
| Product detail | Help users inspect facts, evidence, unknown fields, and why a product matched | Light support / MVP+ | Implement as lightweight evidence drawer; do not build a full e-commerce detail page |
| Comparison | Help users compare current top candidates | Partial support | Limit to 2-4 recommended or selected session candidates; do not support arbitrary deep comparison |
| Updated results | Show revised recommendations after feedback or alternative requests | Full support | Must include "what changed" and the relevant `IntentState` diff |
| Gift request | Interpret recipient, budget, and interest from user-provided context | Partial support | Mark as partial; avoid private recipient inference or over-personalized claims |
| Unsupported request | Handle live stock, checkout, shipping, payment, web scraping, or bundle optimization requests | Full fallback support | Clearly state what cannot be done and offer catalog-backed alternatives |
| Agent trace | Inspect the recommendation pipeline and debug decisions | Internal support | Consumer gets summary; internal route gets full trace |
| Evaluation | Validate agent behavior with metrics and golden cases | Internal MVP quality gate | CLI or internal dashboard must show five core metrics and failed cases |

Final product message: the visible product is a shopping assistant, but the differentiator is that every recommendation is traceable, constraint-safe, and evidence-grounded.

## Resolved Review Decisions

### 1. Main Page Layout

**Conflict**: The current static prototype places recommendation cards in the right rail, while the architecture defines the differentiator as `Chat Assistant + Agent Workflow Panel`.

**Decision**: The production main workspace uses:

```text
Chat + Results                    Agent Workflow Panel
User messages                     Task Router
Assistant response                Intent State
Clarification prompt              Clarification decision
Product cards                     Retrieval summary
Feedback chips                    Constraint summary
Composer                          Ranking / LLM rerank
                                  Evidence trace
```

Product cards move into the chat/results area. The right rail becomes the simplified workflow panel. Full raw trace remains in an internal route.

### 2. Consumer View vs Internal View

**Decision**:

- Consumer route: shopping conversation, product results, simplified "why this was recommended" workflow.
- Internal routes: full trace console, raw trace JSON, evaluation dashboard, replay/debug details.
- Raw user behavior history and full long-term profile must not appear in consumer UI.

Suggested routes:

```text
/                  Consumer shopping workspace
/internal/trace    Full agent trace console
/internal/eval     Evaluation dashboard
```

Suggested backend API surface:

```text
GET  /api/health
POST /api/chat
GET  /api/sessions/{session_id}
GET  /api/products/{product_id}
GET  /api/traces/{turn_id}
GET  /api/internal/traces/{turn_id}
POST /api/evaluation/run
GET  /api/evaluation/runs/{run_id}
```

MVP+ internal APIs:

```text
POST /api/internal/replay/{turn_id}
GET  /api/internal/evaluation/cases
```

### 3. Unified Turn Response

**Decision**: The frontend must be driven by one structured turn response, not page-specific ad hoc payloads.

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

### 4. Product Card Data Ownership

**Decision**: Product card facts, matched tags, evidence, constraint status, and uncertainty notes must come from backend structured payloads. The frontend renders them but does not infer product truth.

Minimum product recommendation payload:

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

### 5. Feedback Update Placement

**Decision**: `FeedbackUpdater` runs before the next retrieval/ranking pass. It must update `IntentState` first so retrieval and ranking reflect the feedback.

Required feedback context:

```text
turn_id
anchor_product_id
feedback_type
feedback_text
intent_before
intent_after
confidence
```

Minimum feedback request:

```ts
interface FeedbackRequest {
  session_id: string;
  turn_id: string;
  feedback_text: string;
  feedback_type?: string;
  anchor_product_id?: string;
}
```

Examples:

- "Too expensive" lowers the price objective relative to the anchor.
- "Avoid this brand" adds the anchor brand to negative preferences.
- "Similar but cheaper" preserves the anchor item and adds a lower-price objective.
- "I don't like this" records an item-level negative anchor unless a reason is given.

### 6. Hard Constraints and Unknown Data

**Decision**:

- Hard violations must not appear in final recommendations.
- LLM rerank cannot restore hard-constraint violations.
- Unknown fields are not the same as satisfied constraints.
- Price `null` under a budget constraint cannot be claimed as "under budget".

Unknown states:

| State | Behavior |
|---|---|
| `unknown_noncritical` | May show with uncertainty label |
| `unknown_critical` | Strongly demote or exclude unless no better candidate exists |
| `violated` | Exclude from final recommendations |

### 7. LLM Boundary

**Decision**:

- LLM may parse intent, generate clarification text, attribute feedback, rerank safe candidates, and write grounded explanations.
- LLM may not invent products, prices, brands, images, reviews, inventory, shipping, or unsupported attributes.
- Every LLM output entering the pipeline must pass schema validation.
- Final recommendations must pass post-rerank validation.
- LLM failure falls back to rule ranking plus template response.

### 8. Trace Contract

**Decision**: Trace is a product feature and an engineering harness, not an afterthought.

Minimum full trace:

```json
{
  "turn_id": "",
  "session_id": "",
  "user_id": "",
  "timestamp": "",
  "input": "",
  "task_route": {
    "task_type": "",
    "confidence": 0.0,
    "rationale": ""
  },
  "intent_before": {},
  "intent_after": {},
  "feedback_update": {},
  "clarification": {
    "should_clarify": false,
    "question": "",
    "reason": "",
    "limits": {}
  },
  "retrieval": {
    "query_text": "",
    "top_k": 0,
    "retrieved_items": []
  },
  "constraint_checks": [],
  "ranking": {
    "ranked_items": [],
    "score_breakdowns": {}
  },
  "llm_rerank": {
    "input_item_ids": [],
    "output_item_ids": [],
    "rationale": "",
    "model": "",
    "prompt_version": ""
  },
  "final_validation": {
    "passed": true,
    "violations": []
  },
  "response": {
    "message": "",
    "product_ids": [],
    "claims": []
  },
  "latency_ms": {},
  "errors": []
}
```

The consumer-facing `TraceSummary` is a reduced view of this full trace.

Minimum trace summary:

```ts
interface TraceSummary {
  turn_id: string;
  task_type: string;
  intent_summary: Record<string, unknown>;
  clarification_decision: Record<string, unknown>;
  retrieved_count: number;
  filtered_count: number;
  ranking_summary: Record<string, unknown>;
  rerank_summary: Record<string, unknown>;
  evidence_sources: string[];
  feedback_update?: Record<string, unknown> | null;
  warnings: string[];
}
```

### 9. Prototype Revision

**Decision**: Keep the existing visual style and page coverage, but revise the main workspace.

Required prototype changes:

- Main page right rail becomes `AgentWorkflowPanel`.
- Product cards move into chat/result area.
- Clarification appears as an in-chat state, not only as a standalone page.
- Feedback updated results show `IntentState` diff and "what changed".
- Comparison table adds constraint status, evidence strength, and unknown fields.
- Product cards use real product images when available plus image fallback.
- Add loading, empty, error, evidence missing, constraint unknown, and clarification limit states.
- Gift page is marked partial support.
- Bundle and live checkout/inventory requests use unsupported fallback.

### 10. Evaluation Gate

**Decision**: Evaluation is required for MVP readiness, even if the internal dashboard is simplified.

MVP evaluation must support command-line execution, JSON output, and golden case failures:

```text
Task Type Accuracy
Intent Slot Accuracy
Constraint Satisfaction
Evidence Coverage
Feedback Recovery
```

Additional engineering metrics:

- Stage latency.
- LLM call count.
- Schema validation failure rate.
- Unknown critical constraint rate.
- Unsupported claim rate.
- Final validation violation count.

## Implementation Architecture

### Backend Layers

```text
API Layer
  chat, sessions, products, traces, evaluation, health

Schema Layer
  IntentState, Product, Candidate, ConstraintCheck,
  RecommendationResult, Trace, EvaluationCase, FeedbackUpdate

Agent Orchestration Layer
  TaskRouter, IntentParser, ClarificationPolicy,
  FeedbackUpdater, LLMReranker, ResponseGenerator

Recommendation Core Layer
  Retriever, ConstraintVerifier, RuleRanker,
  EvidenceRetriever, ProfileService

Storage / Index Layer
  SQLite / Parquet / DuckDB, FAISS, JSONL trace store

Harness Layer
  TraceLogger, ReplayRunner, ConfigManager,
  PromptRegistry, GoldenCaseRunner, Mock/Cached LLM
```

### Frontend Layers

```text
API and Types
  src/api/client.ts
  src/types/*

Feature Modules
  chat
  recommendation
  agentTrace
  evaluation
  fallback

App Layout
  ConsumerLayout
  InternalLayout
```

State model:

```text
idle
  -> submitting
  -> clarifying | recommending | unsupported | ready | error
  -> updating_from_feedback
```

Pipeline loading labels:

```text
Understanding request
Checking catalog
Verifying constraints
Ranking candidates
Preparing answer
```

## Role-Based Task Assignment

### Product Manager

P0:

- Freeze MVP support matrix: full, partial, unsupported.
- Write acceptance criteria for single-item recommendation, negative feedback, alternative recommendation, clarification, unsupported fallback.
- Define hard vs soft constraint examples.
- Define copy rules for unknown data and unsupported capabilities.
- Approve golden demo scenarios.

P1:

- Specify comparison partial-support behavior.
- Specify gift recommendation guardrails.
- Review evidence and uncertainty language.

### Backend Architect / Backend Team

P0:

- Create backend project skeleton.
- Define Pydantic schemas for all core contracts.
- Implement `GET /api/health`.
- Implement config manager.
- Implement trace schema and trace logger.
- Build data quality report format.

P1:

- Implement Amazon metadata/review loaders.
- Normalize product catalog and review evidence.
- Build product store and curated demo pool.
- Build embedding text and FAISS index.
- Implement retriever, constraint verifier, rule ranker.

P2:

- Implement session state manager.
- Implement task router, intent parser, clarification policy, feedback updater.
- Implement chat pipeline orchestrator.
- Implement safe LLM adapter, reranker, grounded response generator.
- Implement final validation.

P3:

- Implement evaluation runner and five metric scripts.
- Implement replay runner.
- Add cached/mock LLM mode.
- Expose full trace and evaluation APIs.

### Frontend Architect / Frontend Team

P0:

- Create React + Vite + TypeScript skeleton.
- Define TypeScript API types for `ChatTurnResponse`, `ProductRecommendation`, `TraceSummary`, `IntentState`.
- Implement API client and mock fixtures.
- Implement base consumer layout with chat/results plus workflow panel.

P1:

- Implement chat flow and product card list.
- Implement clarification UI with answer, skip, and recommend-anyway paths.
- Implement feedback chips carrying `anchor_product_id`.
- Implement loading, empty, error, unsupported, and unknown states.
- Implement simplified `AgentWorkflowPanel`.

P2:

- Implement product evidence drawer.
- Implement comparison table for selected/current candidates.
- Implement internal trace console and session/turn selection.
- Implement responsive layout for desktop, tablet, and mobile.

P3:

- Implement evaluation dashboard and case drilldown.
- Add demo seeds and replay UI.
- Polish accessibility and visual QA.

### Prototype Designer

P0:

- Revise main workspace to `Chat + Results + Workflow Panel`.
- Move product cards into the chat/results area.
- Define product card visual states.
- Define workflow stage visual states: pending, running, completed, warning, failed, skipped, guardrail applied.
- Define clarification in-chat component.

P1:

- Design feedback-updated results with `IntentState` diff.
- Design unsupported fallback template.
- Design comparison table with constraints/evidence/unknown fields.
- Design product evidence drawer.

P2:

- Design internal trace console refinements.
- Design evaluation drilldown states.
- Define responsive behavior for tablet and mobile.

### Evaluation / QA

P0:

- Create 100-300 task and intent cases.
- Create multi-turn feedback golden cases.
- Create demo regression set:
  - simple recommendation
  - clarification required
  - budget constraint
  - brand rejection
  - cheaper alternative
  - unsupported checkout/live inventory

P1:

- Implement metric scripts and JSON run report.
- Add failure logging with linked trace.
- Add thresholds for MVP readiness.

## First Sprint Recommendation

Sprint 1 should not start with the full React UI or LLM polish. It should create the contracts and data foundation that all roles depend on.

Recommended Sprint 1 scope:

1. Backend and frontend skeletons.
2. Shared API/schema contracts.
3. Health endpoint and mock `POST /api/chat`.
4. Static/mock `ChatTurnResponse` fixtures.
5. Revised prototype layout for main workspace.
6. Initial product schema and sample processed product store.
7. Trace schema and first trace fixture.
8. Golden case file format.

## Meeting Sign-Off Criteria

The review is considered aligned when all roles accept:

- MVP scope is full/partial/unsupported by task type.
- Product facts and evidence originate from backend catalog/review data.
- Main experience includes a workflow panel, while full trace/eval stay internal.
- Feedback updates `IntentState` before new retrieval.
- API payloads are structured and typed.
- Prototype revision is tied to implementable component states.
- Evaluation scripts are required before MVP is called complete.
