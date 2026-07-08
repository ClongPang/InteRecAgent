# Evaluation Plan: InteRecAgent

## Evaluation Goal

The first evaluation suite should verify whether InteRecAgent behaves like a reliable recommendation agent, not merely whether an LLM generates fluent shopping text.

The MVP evaluates five core capabilities:

1. Task Type Accuracy
2. Intent Slot Accuracy
3. Constraint Satisfaction
4. Evidence Coverage
5. Feedback Recovery

## 1. Task Type Accuracy

### Purpose

Evaluate whether the Task Router correctly classifies free-form user input.

### Supported Labels

- `single_item_recommendation`
- `negative_feedback`
- `alternative_recommendation`
- `comparison`
- `gift_recommendation`
- `bundle_recommendation`
- `unsupported`

### Metric

```text
Task Type Accuracy = correct_task_predictions / total_cases
```

Optional:

- per-class precision
- per-class recall
- confusion matrix

### Test Cases

Use 100-300 labeled user requests across supported and unsupported tasks.

## 2. Intent Slot Accuracy

### Purpose

Evaluate whether the Intent Parser extracts the right structured fields.

### Target Slots

- category
- budget
- brand preference
- price sensitivity
- priority order
- hard constraints
- soft preferences
- negative preferences
- target user
- uncertainty fields

### Metrics

For categorical or exact fields:

```text
Exact Match Accuracy
```

For list fields:

```text
Precision = correct_extracted_slots / extracted_slots
Recall = correct_extracted_slots / gold_slots
F1 = 2 * precision * recall / (precision + recall)
```

### Notes

Intent parsing can be evaluated manually for the first MVP test set. The test set should include ambiguous, incomplete, and feedback-style queries.

## 3. Constraint Satisfaction

### Purpose

Evaluate whether final recommendations satisfy user hard constraints.

### Constraint States

Each recommended product should be labeled as:

- satisfied
- violated
- unknown

### Metric

```text
Hard Constraint Satisfaction Rate =
  recommendations_without_hard_violations / total_recommendations
```

Also track:

```text
Unknown Critical Constraint Rate =
  products_with_unknown_required_fields / total_recommendations
```

### Product Rule

Hard-constraint violations should not appear in final recommendations. Unknown fields may appear only if clearly marked.

## 4. Evidence Coverage

### Purpose

Evaluate whether product explanations are grounded in product metadata or reviews.

### Evidence Types

- metadata evidence
- feature evidence
- review evidence
- rating evidence
- profile-derived evidence

### Metric

```text
Evidence Coverage =
  recommendation_claims_with_evidence / total_recommendation_claims
```

Track unsupported claims:

```text
Unsupported Claim Rate =
  claims_without_catalog_or_review_support / total_claims
```

### Claim Types to Check

- price claim
- category claim
- brand claim
- attribute claim
- quality claim
- user-fit claim

## 5. Feedback Recovery

### Purpose

Evaluate whether the system updates recommendations after user feedback.

### Feedback Types

- price rejection
- brand rejection
- attribute rejection
- alternative request
- preference strengthening

### Metrics

```text
Feedback Update Accuracy =
  correct_intent_updates / total_feedback_cases
```

```text
Recovery Success Rate =
  corrected_recommendations_after_feedback / total_feedback_cases
```

Examples:

- If the user rejects a brand, the next recommendation should not include that brand unless no alternative exists.
- If the user asks for cheaper alternatives, the next recommendation should lower the price relative to the anchor.

## Evaluation Dataset Structure

Suggested files:

```text
data/eval/task_cases.jsonl
data/eval/intent_cases.jsonl
data/eval/constraint_cases.jsonl
data/eval/evidence_cases.jsonl
data/eval/feedback_cases.jsonl
```

## Evaluation Output

Each evaluation run should produce:

```json
{
  "run_id": "",
  "timestamp": "",
  "metrics": {
    "task_type_accuracy": 0.0,
    "intent_slot_f1": 0.0,
    "constraint_satisfaction": 0.0,
    "evidence_coverage": 0.0,
    "feedback_recovery": 0.0
  },
  "readiness": {
    "passed": false,
    "gates": {
      "task_type_accuracy": {"actual": 0.0, "operator": ">=", "threshold": 0.95, "passed": false},
      "intent_slot_f1": {"actual": 0.0, "operator": ">=", "threshold": 0.9, "passed": false},
      "constraint_satisfaction": {"actual": 0.0, "operator": ">=", "threshold": 1.0, "passed": false},
      "evidence_coverage": {"actual": 0.0, "operator": ">=", "threshold": 0.8, "passed": false},
      "feedback_recovery": {"actual": 0.0, "operator": ">=", "threshold": 0.9, "passed": false},
      "unsupported_claim_rate": {"actual": 0.0, "operator": "<=", "threshold": 0.2, "passed": true},
      "final_validation_violation_rate": {"actual": 0.0, "operator": "<=", "threshold": 0.0, "passed": true},
      "golden_case_coverage": {"actual": "complete", "operator": "complete", "threshold": [], "passed": true}
    }
  },
  "case_failures": []
}
```

## Product Regression Tests

Maintain a small golden set of demo-critical examples:

- simple single-item recommendation
- ambiguous recommendation requiring clarification
- budget-constrained recommendation
- brand rejection feedback
- cheaper alternative request
- unsupported live inventory request

These examples should be run before every demo.

## Non-MVP Future Metrics

Potential future metrics:

- ranking quality using Hit@K/NDCG
- clarification utility
- latency
- cost per recommendation
- user satisfaction
- hallucination rate judged by LLM and human audit

## Evaluation Principle

The first evaluation suite should prioritize agent behavior correctness over ranking benchmark performance. A product-grade agent must first route, understand, verify, explain, and recover reliably.
