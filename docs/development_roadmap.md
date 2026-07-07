# Development Roadmap: InteRecAgent

## Phase 0: Project Setup

### Goals

Prepare the project for FastAPI backend, React frontend, data processing, and evaluation.

### Deliverables

- Repository structure.
- Backend package skeleton.
- Frontend project skeleton.
- Shared API schema definitions.
- Environment configuration.
- Basic documentation.

### Done When

- Backend health endpoint runs.
- Frontend can call backend health endpoint.
- Project has `docs/`, `backend/`, `frontend/`, `data/`, and `tests/` directories.

## Phase 1: Data Pipeline

### Goals

Convert Amazon Reviews 2018 5-core and metadata into a usable product catalog and behavior profile source.

### Deliverables

- Raw data loader.
- Product metadata parser.
- Review parser.
- Product-review join by ASIN.
- 20k-50k product processed catalog.
- Curated demo pool.
- Review evidence snippets.
- User profile builder.

### Done When

- Processed product store can be queried by product ID.
- Review evidence is attached to products.
- Internal user profiles can be generated.

## Phase 2: Retrieval and Ranking Core

### Goals

Build the recommendation core without frontend dependency.

### Deliverables

- Product embedding builder.
- Vector index.
- Retriever service.
- Constraint verifier.
- Rule ranker.
- Basic recommendation API.

### Done When

- A text query returns ranked product candidates.
- Ranking output includes score breakdown.
- Hard-constraint violations are filtered or marked.

## Phase 3: Agent Pipeline

### Goals

Add agentic behavior around the recommendation core.

### Deliverables

- Task Router.
- Intent Parser.
- Session State Manager.
- Clarification Policy.
- Feedback Updater.
- Trace Logger.

### Done When

- System can process multi-turn sessions.
- Negative feedback changes `IntentState`.
- Clarification decisions are logged.
- Trace output can power the workflow panel.

## Phase 4: LLM Integration

### Goals

Integrate LLM capabilities while preserving product grounding.

### Deliverables

- JSON-schema-based LLM intent parsing option.
- LLM reranking over top-N candidates.
- Evidence-grounded response generation.
- Guardrails against fact invention.

### Done When

- LLM rerank never restores hard-constraint violations.
- Final response only refers to supplied candidate data.
- Missing evidence is represented as uncertainty.

## Phase 5: React Demo Frontend

### Goals

Build the user-facing product demo.

### Deliverables

- Chat interface.
- Product card list.
- Agent workflow panel.
- Intent state viewer.
- Recommendation trace viewer.
- Feedback input flow.

### Done When

- User can complete a single-item recommendation flow.
- User can ask for an alternative.
- User can reject a recommendation and receive updated results.
- Workflow panel updates per turn.

## Phase 6: Evaluation Suite

### Goals

Create evaluation scripts for MVP agent behavior.

### Deliverables

- Task Type Accuracy script.
- Intent Slot Accuracy script.
- Constraint Satisfaction script.
- Evidence Coverage script.
- Feedback Recovery script.
- Golden demo regression set.

### Done When

- Evaluation scripts can run from command line.
- Metrics are exported as JSON.
- Failed cases are logged for review.

## Phase 7: Demo Hardening

### Goals

Make the system stable enough for repeated demonstrations.

### Deliverables

- Cached embeddings.
- Optional cached LLM responses for demo cases.
- Error handling for missing metadata.
- Loading states in frontend.
- Demo seed scenarios.
- Documentation for running the demo.

### Done When

- Demo can be started with documented commands.
- Golden examples run successfully.
- Frontend handles backend errors gracefully.

## Suggested Milestone Order

```text
M0: Project skeleton
M1: Processed product catalog
M2: Retrieval + rule ranking CLI/API
M3: Agent pipeline with session state
M4: LLM rerank + response generation
M5: React UI with workflow panel
M6: Evaluation scripts
M7: Demo hardening
```

## Top Implementation Priorities

1. Build a reliable product catalog before building fancy UI.
2. Make `IntentState` observable from day one.
3. Keep hard-constraint verification independent from LLM.
4. Add trace logging early, because debugging agent flows without traces is painful.
5. Keep a curated demo product pool even if the full catalog is larger.

## Main Risks

- Amazon metadata quality may be inconsistent.
- LLM parsing/reranking may be unstable without schema validation.
- Full React UI may slow down early backend iteration.
- User profile construction may overfit to review behavior.
- Dynamic clarification can degrade experience if guardrails are not implemented.

## Recommended First Sprint

Sprint 1 should focus only on:

- repository structure
- Amazon sample data parser
- normalized product schema
- product store
- first vector index
- simple retrieval API

Avoid building the full UI before the data pipeline is stable.
