# Product Requirements Document: InteRecAgent

**Version**: 1.0  
**Date**: 2026-07-07  
**Author**: Sarah (Product Owner)  
**Quality Score**: 93/100

---

## Executive Summary

InteRecAgent is a high-maturity demo product for an e-commerce recommendation agent. It presents itself as a consumer-facing shopping assistant, while exposing an Agent workflow panel that makes the internal recommendation process traceable: task routing, intent parsing, clarification, retrieval, constraint checking, ranking, LLM reranking, evidence-grounded explanation, and feedback update.

The first release uses Amazon Reviews 2018 5-core data and metadata as the product and behavior source. The product does not hard-code a category boundary; the supported recommendation space is determined by the loaded product catalog. The MVP targets free-form user shopping input and provides layered support with graceful degradation.

The key product value is not simply generating recommendations with an LLM. The system must behave like a structured recommendation agent: understand user intent, decide when clarification is necessary, retrieve real products, enforce constraints, explain recommendations with evidence, and update recommendations after feedback.

---

## Product Positioning

### Product Type

- High-maturity demonstrable e-commerce recommendation agent demo.
- FastAPI backend plus React frontend.
- Consumer-facing chat assistant with Agent workflow visualization.
- Product-grade prototype, not a toy chatbot.

### Target Users

**Primary surface user**: consumer looking for shopping recommendations.

**Primary internal user**: developer/researcher validating an agentic recommendation workflow.

### Core Experience

The user enters a natural language shopping request. The system identifies the task type, parses the user's intent, retrieves candidate products from the Amazon product catalog, verifies constraints, ranks candidates, optionally reranks with LLM, and returns product cards with matched tags and evidence. The right-side workflow panel shows how the Agent reached the recommendation.

---

## Problem Statement

### Current Situation

LLM-based shopping assistants often behave like free-form chat systems. They may recommend products without grounding in a real catalog, ignore hard constraints, hallucinate product facts, overuse user history, or fail to update recommendations after negative feedback.

### Proposed Solution

InteRecAgent introduces a structured recommendation pipeline with the following principles:

- User input is routed by task type before recommendation.
- User intent is represented as a structured state.
- Clarification is triggered only when uncertainty and candidate divergence justify it.
- Products must come from the loaded Amazon catalog.
- Hard constraints are verified before LLM reranking.
- Recommendation explanations must be tied to product metadata or review evidence.
- User feedback updates the current intent state and triggers revised recommendations.

### Expected Impact

The MVP should demonstrate a complete and credible product loop:

```text
free-form user request
  -> task routing
  -> intent state
  -> dynamic clarification
  -> retrieval
  -> constraint verification
  -> ranking and LLM reranking
  -> evidence-grounded recommendation
  -> feedback-driven update
```

---

## Success Metrics

### Product Success Metrics

- Task completion: user can receive relevant recommendations for supported tasks.
- Interaction quality: clarification is useful and does not block progress.
- Trustworthiness: product claims are grounded in metadata or reviews.
- Feedback responsiveness: negative feedback changes the next recommendation meaningfully.
- Observability: the workflow panel shows each major decision stage.

### Evaluation Metrics

The first evaluation suite must include:

- Task Type Accuracy
- Intent Slot Accuracy
- Constraint Satisfaction
- Evidence Coverage
- Feedback Recovery

Detailed definitions are maintained in [evaluation_plan.md](evaluation_plan.md).

---

## User Personas

### Persona 1: Shopping Consumer

- **Role**: end user seeking shopping help.
- **Goals**: quickly find suitable products with clear reasons.
- **Pain Points**: vague search results, too many choices, unreliable recommendations.
- **Technical Level**: general consumer.

### Persona 2: Agent Product Builder

- **Role**: developer or product researcher evaluating agent workflows.
- **Goals**: inspect how each recommendation was produced.
- **Pain Points**: opaque LLM output, hard-to-debug recommendation behavior.
- **Technical Level**: advanced.

---

## Core User Stories

### Story 1: Single-Item Intent Recommendation

**As a** shopping consumer,  
**I want to** describe what I want in natural language,  
**So that** I receive product recommendations that match my intent.

**Acceptance Criteria**

- The system identifies the task as `single_item_recommendation`.
- The system extracts category, budget, hard constraints, soft preferences, negative preferences, and uncertainty fields when present.
- Recommendations come from the loaded product catalog.
- Product cards show matched tags and evidence.
- The workflow panel shows intent, retrieval, filtering, ranking, and generation stages.

### Story 2: Dynamic Clarification

**As a** shopping consumer,  
**I want** the assistant to ask only useful questions,  
**So that** I do not waste time answering unnecessary clarifications.

**Acceptance Criteria**

- The system computes whether missing information is important enough to ask.
- Clarification is based on uncertainty and candidate divergence.
- Engineering guardrails prevent infinite questioning.
- If the clarification limit is reached, the system must recommend and mark uncertain assumptions.

### Story 3: Alternative Recommendation

**As a** shopping consumer,  
**I want to** ask for cheaper or similar alternatives,  
**So that** I can compare options without restarting the conversation.

**Acceptance Criteria**

- The system identifies `alternative_recommendation`.
- The previous positive anchor item or recommendation context is used.
- The updated ranking prioritizes similarity plus the requested difference, such as lower price.
- The response explains what changed from the previous recommendation.

### Story 4: Negative Feedback Re-Recommendation

**As a** shopping consumer,  
**I want to** reject a recommendation by giving a reason,  
**So that** the next recommendation better reflects my preferences.

**Acceptance Criteria**

- The system identifies feedback such as brand rejection, price rejection, form-factor rejection, or quality concern.
- The current `IntentState` is updated.
- The next recommendation excludes or downgrades rejected attributes.
- The workflow panel shows the feedback update.

### Story 5: Graceful Degradation

**As a** shopping consumer,  
**I want** the assistant to be honest when data is insufficient,  
**So that** I am not misled by unsupported claims.

**Acceptance Criteria**

- Unsupported tasks are detected by Task Router.
- Missing catalog coverage is surfaced to the user.
- The assistant does not invent unavailable products, prices, reviews, or attributes.
- The response gives a useful fallback path.

---

## Functional Requirements

### Task Router

- Classifies free-form user input into task types:
  - `single_item_recommendation`
  - `negative_feedback`
  - `alternative_recommendation`
  - `comparison`
  - `gift_recommendation`
  - `bundle_recommendation`
  - `unsupported`
- Provides layered support:
  - full support for single item, negative feedback, and alternative recommendation.
  - partial support for comparison and gift recommendation.
  - graceful degradation for bundle recommendation and unsupported requests.

### Intent Parser

- Extracts structured intent fields:
  - `task_type`
  - `category`
  - `goal`
  - `scenario`
  - `budget`
  - `brand_preference`
  - `price_sensitivity`
  - `priority_order`
  - `hard_constraints`
  - `soft_preferences`
  - `negative_preferences`
  - `target_user`
  - `uncertainty_fields`
  - `feedback_history`
  - `long_term_profile`
- Excludes MVP fields:
  - `risk_flags`
  - `use_frequency`

### User Profile Builder

- Builds internal user profiles from Amazon behavior data.
- Uses review, rating, and interaction history to infer:
  - favored categories
  - preferred brands
  - price range tendencies
  - positively reviewed items
  - negatively reviewed items
- Does not expose raw user history in the UI.

### Clarification Policy

- Determines whether to ask a clarification question.
- Considers:
  - missing intent fields
  - importance of missing fields
  - divergence among top candidate products
  - confidence of task and intent parsing
- Applies safety limits:
  - max consecutive clarifications: 3
  - max total dialogue turns before recommendation: 5
- If limits are reached, recommends with uncertainty labels.

### Retrieval

- Uses vector retrieval as the primary retrieval path.
- Retrieval input includes user query, structured intent, and current profile signal.
- Returns candidate products from the loaded Amazon product catalog.

### Constraint Verifier

- Checks whether candidates satisfy hard constraints.
- Labels each constraint status:
  - satisfied
  - violated
  - unknown
- Hard-constraint violations are filtered or strongly demoted before LLM reranking.
- Unknown critical attributes are shown as uncertainty when relevant.

### Rule Ranker

- Produces a transparent score before LLM reranking.
- Suggested scoring components:
  - intent match
  - hard constraint satisfaction
  - soft preference match
  - brand match
  - price fit
  - rating/review quality
  - profile compatibility
  - uncertainty penalty

### LLM Reranker

- Reranks top candidates after retrieval and rule ranking.
- Cannot reintroduce candidates that violated hard constraints.
- Produces short rerank rationale for workflow inspection.

### Response Generator

- Generates user-facing recommendation text.
- Uses structured candidate data only.
- Displays:
  - product card
  - price
  - image
  - matched tags
  - evidence snippets
  - uncertainty notes
  - next possible action

### Feedback Updater

- Parses feedback into structured changes.
- Supports:
  - brand rejection
  - price rejection
  - product attribute rejection
  - preference strengthening
  - alternative request
- Updates `IntentState` and triggers a revised recommendation flow.

### Agent Workflow Panel

- Shows:
  - task type
  - parsed intent
  - clarification decision
  - retrieval count
  - constraint filtering summary
  - ranking score breakdown
  - LLM rerank summary
  - evidence sources
  - feedback updates

---

## Out of Scope for MVP

- Real checkout or payment.
- Real-time price, inventory, or shipping lookup.
- Sponsored/ad ranking.
- Full marketplace search across live e-commerce websites.
- Medical, financial, or highly regulated recommendation handling.
- Full bundle optimization.
- Public developer SDK.
- Exposing raw user behavior history to frontend users.

---

## Technical Constraints

### Backend

- FastAPI service.
- Modular Python agent pipeline.
- Persistent product store and vector index.
- API endpoints for chat, recommendation, product lookup, workflow trace, and evaluation.

### Frontend

- React application.
- Chat-style interaction.
- Product card result area.
- Agent workflow side panel.
- Evaluation/debug view can be hidden from normal consumer mode.

### Data

- Source: Amazon Reviews 2018 / legacy 5-core dataset plus metadata.
- MVP scale: 20k-50k products.
- Supports an extractable curated product pool for polished demos.

### Performance Targets

- First response for cached/indexed data: preferably under 10 seconds.
- Retrieval and rule ranking should complete before LLM reranking.
- LLM reranking should operate on a small top-N candidate set.

---

## MVP Scope

### Required MVP Features

- Amazon data ingestion.
- Product catalog normalization.
- User profile construction from behavior data.
- Vector index building.
- Task Router.
- Intent Parser.
- Clarification Policy with guardrails.
- Retrieval and rule ranking.
- LLM reranking.
- Constraint verification.
- Evidence-grounded response generation.
- Feedback update loop.
- React chat UI.
- Product card UI.
- Agent workflow panel.
- Evaluation scripts for five core metrics.

### MVP Definition

The MVP is complete when a user can open the React demo, enter a free-form shopping request, receive grounded product recommendations, inspect the Agent workflow, provide negative feedback or ask for alternatives, and see the system update its recommendation using the current intent state and product evidence.

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|---|---:|---:|---|
| Amazon 5-core metadata lacks clean attributes | High | High | Normalize available metadata, extract attributes from title/features, represent missing values as unknown |
| Unlimited clarification degrades UX | Medium | High | Apply engineering guardrails and recommend with uncertainty after limits |
| LLM reranker overrides constraints | Medium | High | Run hard filtering before rerank and validate final list after rerank |
| Full catalog is too noisy for demo | High | Medium | Maintain a curated demo pool in addition to the larger product index |
| User profile from reviews may be sparse or biased | Medium | Medium | Use profile as weak signal and fall back to session intent |
| Response latency is high | Medium | Medium | Cache embeddings, restrict LLM rerank to top-N, stream frontend states |

---

## Dependencies

- Amazon Reviews 2018 5-core and metadata files.
- Embedding model for vector retrieval.
- LLM provider or local LLM interface for parsing/reranking/response generation.
- Vector index library.
- React frontend build stack.
- FastAPI backend runtime.

---

## Final Product Principle

InteRecAgent must not behave like an LLM that invents shopping advice. It should behave like a recommendation system with an Agent interface: grounded in product data, explicit about uncertainty, responsive to feedback, and transparent about its decision process.
