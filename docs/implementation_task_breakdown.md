# InteRecAgent Implementation Task Breakdown

**Source**: Review meeting consensus in `docs/review_meeting_consensus.md`  
**Purpose**: Convert the agreed product, backend, frontend, prototype, and evaluation decisions into assignable work.

## Delivery Rule

Every implementation task must preserve these review decisions:

- Backend owns product facts, matched tags, evidence, constraint status, workflow summaries, and feedback updates.
- Frontend renders structured payloads and does not infer recommendation truth.
- `FeedbackUpdater` updates `IntentState` before the next retrieval pass.
- Consumer UI shows a safe workflow summary; internal routes show full trace/evaluation details.
- MVP is not complete until the five evaluation metrics can run on golden cases.

## Sprint 1: Contract and Skeleton

Goal: make frontend, backend, prototype, and evaluation teams build against the same contract.

| ID | Owner | Task | Dependencies | Done When |
|---|---|---|---|---|
| PM-001 | Product Manager | Freeze support matrix for full / partial / unsupported tasks | Review consensus | `single_item_recommendation`, `negative_feedback`, `alternative_recommendation`, `comparison`, `gift`, `bundle`, `unsupported` have explicit behavior and acceptance criteria |
| PM-002 | Product Manager | Write copy rules for unknown facts and unsupported capabilities | PM-001 | Copy exists for price unknown, evidence missing, live inventory unsupported, checkout unsupported, bundle fallback |
| BE-001 | Backend | Create FastAPI backend skeleton and health endpoint | None | `GET /api/health` returns service status |
| BE-002 | Backend | Define Pydantic schemas for API contracts | PM-001 | `IntentState`, `ChatTurnResponse`, `ProductRecommendation`, `TraceSummary`, `InternalTrace`, `FeedbackRequest` exist and validate sample fixtures |
| BE-003 | Backend | Create trace logger and JSONL trace store | BE-002 | A mock chat turn writes a trace containing task route, intent, retrieval summary, validation, response |
| BE-004 | Backend | Implement mock `POST /api/chat` with stable `ChatTurnResponse` | BE-002, BE-003 | Frontend can render recommendation, clarification, unsupported, and feedback-updated mock responses |
| FE-001 | Frontend | Create React + Vite + TypeScript skeleton | None | App starts locally and renders an empty consumer workspace |
| FE-002 | Frontend | Define TypeScript types and API client | BE-002 | Types mirror backend contract and mock fixtures compile |
| FE-003 | Frontend | Implement Consumer workspace layout | FE-001 | Desktop layout shows Chat + Results + Workflow Panel |
| FE-004 | Frontend | Render mock `ChatTurnResponse` states | FE-002, FE-003, BE-004 | UI renders recommendation, clarification, unsupported, error, and feedback update states from fixtures |
| UX-001 | Prototype Designer | Revise main prototype layout | Review consensus | Static prototype shows ProductCards in chat/results and right rail as AgentWorkflowPanel |
| UX-002 | Prototype Designer | Define component states | UX-001 | ProductCard, WorkflowStage, ClarificationPrompt, UnsupportedFallback, LoadingState, ErrorState have visual states |
| QA-001 | Evaluation / QA | Define golden case JSONL schema | PM-001, BE-002 | Case schema supports task, intent, constraint, evidence, and feedback expectations |
| QA-002 | Evaluation / QA | Draft initial golden cases | QA-001 | At least six demo cases exist: simple recommendation, clarification, budget, brand rejection, cheaper alternative, unsupported checkout |

## Sprint 2: Data Foundation and Recommendation Core

Goal: return real catalog-backed candidates with traceable scores and constraints.

| ID | Owner | Task | Dependencies | Done When |
|---|---|---|---|---|
| DATA-001 | Backend / Data | Implement Amazon metadata loader | BE-002 | Raw metadata can be parsed into normalized product records |
| DATA-002 | Backend / Data | Implement review loader and evidence extraction baseline | BE-002 | Reviews attach to product IDs and produce evidence snippets |
| DATA-003 | Backend / Data | Generate data quality report | DATA-001, DATA-002 | Report includes price, image, brand, category, review, evidence coverage |
| DATA-004 | Backend / Data | Build curated demo pool | DATA-003 | Demo pool favors complete products with price, image, category, and evidence |
| BE-005 | Backend | Implement product store and product lookup API | DATA-001 | `GET /api/products/{product_id}` returns catalog facts only |
| BE-006 | Backend | Build embedding text and FAISS index | DATA-004 | Product candidates can be retrieved from natural language query |
| BE-007 | Backend | Implement retriever service | BE-006 | Retriever returns top-K product IDs and retrieval scores |
| BE-008 | Backend | Implement constraint verifier | BE-005, BE-007 | Candidates are labeled `satisfied`, `violated`, `unknown_noncritical`, or `unknown_critical` |
| BE-009 | Backend | Implement rule ranker | BE-008 | Ranked candidates include score breakdowns |
| BE-010 | Backend | Implement final validator | BE-008, BE-009 | Hard violations cannot enter final recommendations |
| FE-005 | Frontend | Render real ProductRecommendation cards | BE-005, BE-004 | Product cards show title, image/fallback, price/unknown, category, tags, evidence, uncertainties |
| FE-006 | Frontend | Render WorkflowPanel summary | BE-003, BE-004 | Panel shows task, intent summary, clarification decision, retrieved/filtered counts, ranking/rerank/evidence summaries |
| QA-003 | Evaluation / QA | Implement constraint satisfaction evaluator baseline | BE-008 | Evaluator detects hard-constraint violations and unknown critical constraints |

## Sprint 3: Agent Pipeline

Goal: support multi-turn recommendation behavior with intent, clarification, and feedback updates.

| ID | Owner | Task | Dependencies | Done When |
|---|---|---|---|---|
| BE-011 | Backend | Implement session state manager | BE-002, BE-003 | Sessions store messages, current `IntentState`, recommendation history, feedback history |
| BE-012 | Backend | Implement task router | BE-011 | Router classifies MVP task labels with confidence and rationale |
| BE-013 | Backend | Implement intent parser baseline | BE-012 | Parser updates `IntentState` fields and uncertainty fields |
| BE-014 | Backend | Implement clarification policy | BE-013, BE-007 | Policy asks one high-value question or recommends with uncertainty; respects limits |
| BE-015 | Backend | Implement feedback updater | BE-011, BE-013 | Feedback creates `intent_before`, `intent_after`, anchor, confidence, and update reason |
| BE-016 | Backend | Implement full chat orchestrator | BE-007, BE-010, BE-014, BE-015 | `POST /api/chat` executes the fixed pipeline and writes trace per turn |
| FE-007 | Frontend | Implement clarification prompt | BE-014 | UI supports options, free answer, skip, and recommend-anyway |
| FE-008 | Frontend | Implement feedback actions with anchors | BE-015 | Feedback chips send `turn_id`, `feedback_type`, `feedback_text`, `anchor_product_id` |
| FE-009 | Frontend | Render "what changed" on updated results | BE-015, BE-016 | UI shows budget/brand/attribute/anchor changes after feedback |
| QA-004 | Evaluation / QA | Implement task type and intent slot evaluators | BE-012, BE-013 | Metrics run on JSONL cases and output JSON report |
| QA-005 | Evaluation / QA | Implement feedback recovery evaluator | BE-015, BE-016 | Evaluator checks intent updates and corrected recommendations after feedback |

## Sprint 4: LLM Integration and Grounding

Goal: add schema-validated LLM behavior without losing product grounding.

| ID | Owner | Task | Dependencies | Done When |
|---|---|---|---|---|
| BE-017 | Backend | Implement OpenAI-compatible LLM adapter | BE-002 | Adapter supports schema-validated JSON, cached mode, mock mode |
| BE-018 | Backend | Add LLM intent parsing option | BE-017, BE-013 | Parser output passes Pydantic validation and falls back to baseline on failure |
| BE-019 | Backend | Add LLM reranker over safe top-N | BE-017, BE-010 | Reranker cannot restore filtered hard violations |
| BE-020 | Backend | Implement grounded response generator | BE-017, BE-005 | Response claims bind to metadata, feature, review, rating, or profile-derived support |
| BE-021 | Backend | Add claim-level evidence records | BE-020 | Evidence coverage evaluator can inspect supported vs unsupported claims |
| QA-006 | Evaluation / QA | Implement evidence coverage evaluator | BE-020, BE-021 | Unsupported claim rate and evidence coverage are reported |
| FE-010 | Frontend | Render evidence source and uncertainty states | BE-020, BE-021 | UI distinguishes supported evidence, missing evidence, unknown attribute, and non-real-time facts |

## Sprint 5: Internal Tools and Demo Hardening

Goal: make the demo inspectable, replayable, and stable.

| ID | Owner | Task | Dependencies | Done When |
|---|---|---|---|---|
| BE-022 | Backend | Implement full trace API | BE-003, BE-016 | `GET /api/internal/traces/{turn_id}` returns full internal trace |
| BE-023 | Backend | Implement evaluation runner APIs | QA-004, QA-005, QA-006 | `POST /api/evaluation/run` and `GET /api/evaluation/runs/{run_id}` return run summaries |
| BE-024 | Backend | Implement replay runner baseline | BE-003, BE-016 | Internal tool can rerun a recorded turn with fixed config |
| FE-011 | Frontend | Implement internal trace page | BE-022 | Developers can inspect task route, intent diff, retrieved IDs, filtered reasons, ranking, rerank, validation |
| FE-012 | Frontend | Implement evaluation dashboard | BE-023 | Dashboard shows five metrics, golden cases, failure drilldown |
| FE-013 | Frontend | Implement product detail drawer | FE-005, BE-005, BE-021 | Drawer shows catalog facts, evidence, unknown fields, feedback actions |
| FE-014 | Frontend | Implement partial comparison table | FE-005, BE-016 | Table compares selected/current candidates with constraints, evidence, unknowns, suggested choice |
| UX-003 | Prototype Designer | Final visual QA across states | FE-011, FE-012, FE-013, FE-014 | Desktop/tablet/mobile views do not overflow, overlap, or hide primary actions |
| QA-007 | Evaluation / QA | Define MVP readiness thresholds | QA-004, QA-005, QA-006 | Thresholds exist for five metrics plus unsupported claim and final validation violations |

## Dependency Order

```text
Support matrix
  -> API/schema contracts
  -> mock chat response
  -> frontend skeleton + revised prototype
  -> data pipeline
  -> retrieval/ranking core
  -> agent pipeline
  -> LLM grounding
  -> evaluation + internal tools
```

## MVP Readiness Checklist

- [ ] Backend and frontend both use the same `ChatTurnResponse` contract.
- [ ] Main workspace is `Chat + Results + Workflow Panel`.
- [ ] Product card fields are backend-owned.
- [ ] Feedback actions include anchors.
- [ ] Feedback updates intent before retrieval.
- [ ] Hard-constraint violations cannot enter final recommendations.
- [ ] Unknown facts are explicitly labeled.
- [ ] Unsupported live commerce requests degrade cleanly.
- [ ] Full traces are written for every turn.
- [ ] Consumer trace summary and internal full trace are separated.
- [ ] Five evaluation metrics run from the command line or API.
- [ ] Golden regression cases cover the critical demo paths.

