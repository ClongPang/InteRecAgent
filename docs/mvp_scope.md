# MVP Scope: InteRecAgent

## Product Summary

InteRecAgent MVP is a high-maturity demo of an e-commerce recommendation agent. It supports free-form shopping input, routes the task, models user intent, retrieves real products from an Amazon-derived catalog, verifies constraints, ranks candidates, reranks with LLM, explains with evidence, and updates recommendations after feedback.

## Confirmed Decisions

| Area | Decision |
|---|---|
| Product type | High-maturity demonstrable demo |
| Frontend | React |
| Backend | FastAPI |
| Data source | Amazon Reviews 2018 / legacy 5-core plus metadata |
| Product scale | 20k-50k products plus curated demo pool |
| Category boundary | No hard-coded category restriction; coverage follows loaded catalog |
| Product info | Title, price, category, attributes, image, reviews, behavior data |
| User profile | Built from Amazon behavior data, internal only |
| Core tasks | Single-item recommendation, negative feedback re-recommendation, alternative recommendation |
| Interaction | Dynamic clarification with protection limits |
| Ranking | Vector retrieval + rule ranking + LLM reranking |
| Evaluation | Required in MVP |

## MVP Must-Have Capabilities

### 1. Free-Form Shopping Input

The user can enter unconstrained shopping needs, such as:

- "Recommend a wireless mouse for office use."
- "I want headphones under 100 dollars."
- "Not this brand, show me another one."
- "Is there a cheaper alternative?"

### 2. Task Routing

The system classifies each user message into one of the following:

- `single_item_recommendation`
- `negative_feedback`
- `alternative_recommendation`
- `comparison`
- `gift_recommendation`
- `bundle_recommendation`
- `unsupported`

Only the first three are full-support MVP tasks.

### 3. Structured Intent State

The MVP maintains the following fields:

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

Excluded in MVP:

- `risk_flags`
- `use_frequency`

### 4. Dynamic Clarification

The system decides whether to clarify based on:

- missing high-value intent fields
- uncertainty in task or slot extraction
- divergence among top candidates
- ambiguity in budget/category/scenario

Protection limits:

```text
max_consecutive_clarifications = 3
max_total_dialog_turns_before_recommend = 5
```

### 5. Product Retrieval and Ranking

MVP ranking flow:

```text
user query + intent state
  -> vector retrieval
  -> rule scoring
  -> constraint verification
  -> LLM rerank on top-N
  -> final product list
```

LLM rerank may reorder candidates but must not restore products that violate hard constraints.

### 6. Evidence-Grounded Recommendation

Each product card should show:

- product image
- title
- price
- category
- matched tags
- evidence snippets from metadata or reviews
- uncertainty notes when evidence is missing

### 7. Feedback Update

The system supports follow-up messages like:

- "Too expensive."
- "I don't want this brand."
- "Show me something similar but cheaper."
- "I prefer something more portable."

These update the current `IntentState` and trigger revised retrieval/ranking.

### 8. Agent Workflow Panel

The frontend must show a workflow trace:

- task type
- parsed intent
- clarification decision
- retrieved candidate count
- filtered candidate count
- ranking score summary
- LLM rerank rationale
- evidence sources
- feedback updates

### 9. Evaluation Scripts

MVP includes scripts for:

- Task Type Accuracy
- Intent Slot Accuracy
- Constraint Satisfaction
- Evidence Coverage
- Feedback Recovery

## Nice-to-Have for MVP

- Comparison task partial support.
- Gift recommendation partial support.
- Curated demo scenarios.
- Frontend mode switch between "consumer view" and "debug view".
- Cached LLM outputs for demos.

## Out of Scope

- Real checkout.
- Real-time inventory or shipping.
- Live web scraping during recommendation.
- Sponsored ranking.
- Full bundle optimization.
- Developer SDK.
- Full high-risk product handling.

## MVP Acceptance Checklist

- [ ] User can input a free-form shopping request.
- [ ] System routes the task correctly.
- [ ] System builds and updates `IntentState`.
- [ ] System asks clarification only when needed.
- [ ] System retrieves real products from the loaded catalog.
- [ ] System filters or demotes hard-constraint violations.
- [ ] System returns product cards with evidence.
- [ ] User feedback updates the next recommendation.
- [ ] Workflow panel shows traceable decision stages.
- [ ] Evaluation scripts run on a small test set.
