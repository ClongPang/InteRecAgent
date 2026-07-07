# System Architecture: InteRecAgent

## Architecture Overview

InteRecAgent uses a modular FastAPI backend and a React frontend. The backend exposes an agentic recommendation pipeline; the frontend provides a chat interface, product cards, and an Agent workflow visualization panel.

```text
React Frontend
  -> Chat API
  -> FastAPI Backend
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
      -> Evaluation Service
```

## Frontend Architecture

### Main Layout

```text
-------------------------------------------------------
| Chat Assistant              | Agent Workflow Panel   |
|                             |                        |
| User messages               | Task Type              |
| Assistant messages          | Intent State           |
| Input box                   | Clarification Decision |
|                             | Retrieval Summary      |
| Product Cards               | Ranking Scores         |
|                             | Evidence Trace         |
-------------------------------------------------------
```

### Frontend Components

- `ChatWindow`
  - Displays user and assistant messages.
  - Handles message submission.

- `ProductCardList`
  - Displays recommended products.
  - Shows image, title, price, matched tags, evidence, and uncertainty notes.

- `AgentWorkflowPanel`
  - Displays task type, parsed intent, retrieval/filtering/ranking trace.

- `IntentStateView`
  - Renders current structured user intent.

- `EvaluationDebugView`
  - Optional developer view for evaluation outputs and trace logs.

## Backend Architecture

### API Layer

Recommended endpoints:

```text
POST /api/chat
GET  /api/session/{session_id}
GET  /api/products/{product_id}
GET  /api/trace/{turn_id}
POST /api/evaluate
```

### Backend Modules

#### Task Router

Input:

- user message
- session state
- previous assistant turn

Output:

- task type
- confidence
- routing rationale

Supported task types:

- `single_item_recommendation`
- `negative_feedback`
- `alternative_recommendation`
- `comparison`
- `gift_recommendation`
- `bundle_recommendation`
- `unsupported`

#### Intent Parser

Input:

- user message
- task type
- previous `IntentState`

Output:

- updated `IntentState`
- uncertainty fields
- extraction confidence

The parser can use LLM output with strict JSON schema validation.

#### Session State Manager

Responsibilities:

- maintain per-session messages
- store current `IntentState`
- keep recommendation history
- store feedback history
- provide state to downstream modules

#### User Profile Service

Responsibilities:

- build internal profile from Amazon user behavior
- compute category preferences
- compute brand tendencies
- compute price sensitivity
- provide weak personalization signals

Important constraint:

- raw behavior history is not exposed to frontend users.

#### Clarification Policy

Input:

- `IntentState`
- task confidence
- candidate preview if available
- clarification history

Output:

- `should_clarify`
- clarification question
- reason

Guardrails:

```text
max_consecutive_clarifications = 3
max_total_dialog_turns_before_recommend = 5
```

#### Product Retriever

Responsibilities:

- query vector index
- retrieve top-K candidates
- optionally combine catalog/category filters
- return product IDs and retrieval scores

Input text should combine:

- original user query
- category
- scenario
- hard constraints
- soft preferences
- negative preferences

#### Constraint Verifier

Responsibilities:

- evaluate hard constraints
- evaluate soft preference matches
- label constraint state:
  - `satisfied`
  - `violated`
  - `unknown`
- remove or strongly demote hard violations

#### Rule Ranker

Scoring components:

```text
score =
  intent_match_score
  + hard_constraint_score
  + soft_preference_score
  + brand_score
  + price_fit_score
  + rating_score
  + profile_score
  - uncertainty_penalty
  - feedback_penalty
```

Output:

- ranked candidates
- score breakdown

#### LLM Reranker

Input:

- top-N candidates after rule ranking
- intent state
- candidate evidence

Output:

- reranked top candidates
- short rationale

Constraint:

- cannot bring back hard-constraint violations.

#### Response Generator

Responsibilities:

- generate assistant response
- build product card payload
- cite evidence snippets
- state uncertainty clearly
- suggest next action

#### Feedback Updater

Responsibilities:

- detect negative feedback and alternative requests
- update `negative_preferences`
- update budget/brand/category constraints if implied
- trigger revised recommendation

#### Trace Logger

Stores:

- user input
- task route
- intent state
- clarification decision
- retrieved IDs
- filtered IDs and reasons
- ranking scores
- LLM rerank result
- final response
- user feedback

Trace logs support the workflow panel and evaluation scripts.

## Data Stores

### Product Store

Stores normalized products:

- product ID
- title
- category
- brand
- price
- attributes
- image URL
- review summary
- evidence snippets
- rating statistics

### Review Store

Stores raw or cleaned review evidence:

- review ID
- user ID
- product ID
- rating
- text
- timestamp
- extracted evidence aspects

### User Profile Store

Stores internal profile:

- user ID
- preferred categories
- preferred brands
- price sensitivity
- positive item anchors
- negative item anchors

### Vector Index

Embeddings should be built from:

- product title
- category
- brand
- features
- metadata description
- selected review summary

## Request Flow

```text
1. User sends message.
2. Backend loads session state.
3. Task Router classifies the message.
4. Intent Parser updates IntentState.
5. User Profile Service injects internal profile signal.
6. Clarification Policy decides whether to ask a question.
7. If no clarification: Retriever fetches candidates.
8. Constraint Verifier filters/demotes candidates.
9. Rule Ranker scores candidates.
10. LLM Reranker reranks top-N.
11. Response Generator creates final response and product cards.
12. Trace Logger records the full turn.
13. Frontend renders chat, product cards, and workflow panel.
```

## Engineering Guardrails

- Product facts must come from catalog/review data.
- Missing attributes must be marked as unknown.
- LLM cannot invent product IDs, prices, categories, or reviews.
- Hard constraints are checked before and after LLM reranking.
- User profile is a weak signal; current session intent has priority.
- Clarification has engineering limits even if the product behavior is dynamic.

## Suggested Repository Structure

```text
backend/
  app/
    api/
    core/
    models/
    services/
      task_router.py
      intent_parser.py
      profile_service.py
      clarification_policy.py
      retriever.py
      constraint_verifier.py
      ranker.py
      llm_reranker.py
      response_generator.py
      feedback_updater.py
      trace_logger.py
    evaluation/
    data_pipeline/
frontend/
  src/
    components/
    pages/
    api/
    state/
data/
  raw/
  processed/
  indexes/
docs/
tests/
```
